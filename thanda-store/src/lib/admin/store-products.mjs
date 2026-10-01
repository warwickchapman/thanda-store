import { assertHubSnapshot, hubFetch } from '../xero/hub.mjs';
import { skuReplacementContext, victronSkuFamilyResolver } from '../victron-sku-family.mjs';

export class ProductInputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const code = value => String(value || '').trim().toUpperCase();

export function validateStoreProduct(input) {
  const bounded = (key, label, max) => {
    const value = typeof input[key] === 'string' ? input[key].trim() : '';
    if (!value || value.length > max) throw new ProductInputError(`${label} is required (maximum ${max} characters).`);
    return value;
  };
  const name = bounded('name', 'Name', 200);
  const description = bounded('description', 'Description', 10000);
  const category = bounded('category', 'Category', 100);
  const price = String(input.price ?? '').trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(price) || Number(price) <= 0 || Number(price) > 9999999999.99) {
    throw new ProductInputError('Enter a selling price greater than zero, with at most two decimal places.');
  }
  if (typeof input.visible !== 'boolean') throw new ProductInputError('Choose whether the product is visible in the store.');
  return { name, description, category, price: Number(price), visible: input.visible };
}

export async function storedXeroItems() {
  // Stored Hub evidence only: no refresh, provider request, pagination or retry.
  const response = await hubFetch('/Items');
  if (!response.ok) throw new Error('Stored Xero items unavailable');
  const payload = await response.json();
  assertHubSnapshot(payload);
  if (!Array.isArray(payload.Items)) throw new Error('Stored Xero item list is malformed');
  return { items: payload.Items, observedAt: payload._hub.observed_at };
}

export function xeroStockDetails(item, observedAt) {
  const raw = item?.QuantityOnHand;
  const quantity = raw === null || raw === undefined || raw === '' ? null : Number(raw);
  return {
    localStockOnHand: item?.IsTrackedAsInventory === true && Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : null,
    xeroStockStatus: !item ? 'missing' : item.IsTrackedAsInventory === true ? 'tracked' : 'untracked',
    xeroStockSyncedAt: observedAt,
  };
}

export function matchingXeroItem(product, byCode, byId) {
  if (product.details?.storeManaged !== true) return byCode.get(code(product.sku));
  const item = byId.get(product.details.xeroItemId);
  // A renamed/reused Xero code must not silently repoint an existing store item.
  return item && code(item.Code) === code(product.sku) ? item : undefined;
}

export function existingStoreProduct(item, products) {
  const article = victronSkuFamilyResolver([]);
  return products.find(product => product.details?.xeroItemId === item.ItemID
    || code(product.sku) === code(item.Code)
    || (product.supplier === 'victron' && article(product.sku) === article(item.Code)));
}

export function searchXeroProducts(items, products, successions, query) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = items.filter(item => item.IsSold === true && item.ItemID && code(item.Code)
    && terms.every(term => `${item.Code} ${item.Name || ''} ${item.Description || ''}`.toLowerCase().includes(term)));
  const results = matches.map(item => {
    const existing = existingStoreProduct(item, products);
    const context = skuReplacementContext(successions, item.Code);
    return {
      itemId: item.ItemID, sku: item.Code, name: item.Name || item.Code,
      description: item.Description || item.Name || item.Code,
      price: item.SalesDetails?.UnitPrice ?? '',
      existing: existing ? { id: Number(existing.id), editable: existing.details?.storeManaged === true, hidden: existing.details?.hidden === true } : null,
      replaces: context.replaces, replacedBy: context.replacedBy,
    };
  }).sort((a, b) => Number(Boolean(a.existing)) - Number(Boolean(b.existing)) || a.sku.localeCompare(b.sku));
  return { items: results.slice(0, 50), total: results.length };
}

export async function ensureStoreProductSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS store_product_images (
    product_id BIGINT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
    image BYTEA NOT NULL,
    revision TEXT NOT NULL
  )`);
}

export async function productIndex(db) {
  const products = await db.query('SELECT id,sku,supplier,details FROM products');
  const successions = await db.query('SELECT predecessor_sku,successor_sku FROM victron_sku_successions');
  return { products: products.rows, successions: successions.rows };
}

export async function saveStoreProduct(pool, { id, item, observedAt, input, image, imageRevision, actorId }) {
  const fields = validateStoreProduct(input);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Serialize imports as well as edits; recheck duplicates inside the lock.
    await db.query('SELECT pg_advisory_xact_lock(742041)');
    await ensureStoreProductSchema(db);
    let productId = id;
    const editorial = {
      description: fields.description, hidden: !fields.visible,
      recommendedRetailExVat: fields.price, recommendedRetailPriceVatMode: 'ex_vat',
      storeManaged: true, supplierStockManaged: false, supplierStockStatus: 'unknown',
      storeEditedBy: actorId, storeEditedAt: new Date().toISOString(),
    };
    if (id) {
      const result = await db.query(`UPDATE products SET name=$2, category=$3, price=$4,
        details=(details - 'catalogueClassification' - 'catalogueMeasurements' - 'catalogueAttributes' - 'catalogueAttributeSources') || $5::jsonb,
        last_updated=NOW() WHERE id=$1 AND details->>'storeManaged'='true' RETURNING id`,
      [id, fields.name, fields.category, fields.price, JSON.stringify(editorial)]);
      if (!result.rowCount) throw new ProductInputError('This product is not editable here.', 404);
    } else {
      if (!item?.ItemID || !code(item.Code) || item.IsSold !== true) throw new ProductInputError('Select a Xero item that is available for sale.');
      const existing = await db.query('SELECT id,sku,supplier,details FROM products');
      if (existingStoreProduct(item, existing.rows)) throw new ProductInputError('This Xero item is already in the catalogue. Search again to see its status.', 409);
      const details = { ...editorial, xeroItemId: item.ItemID, ...xeroStockDetails(item, observedAt) };
      const result = await db.query(`INSERT INTO products (sku,supplier,supplier_item_id,name,category,price,details)
        VALUES ($1,'thanda',$2,$3,$4,$5,$6::jsonb) RETURNING id`,
      [String(item.Code).trim(), item.ItemID, fields.name, fields.category, fields.price, JSON.stringify(details)]);
      productId = Number(result.rows[0].id);
    }
    if (image) {
      await db.query(`INSERT INTO store_product_images(product_id,image,revision) VALUES($1,$2,$3)
        ON CONFLICT(product_id) DO UPDATE SET image=EXCLUDED.image, revision=EXCLUDED.revision`, [productId, image, imageRevision]);
      await db.query('UPDATE products SET image_url=$2 WHERE id=$1', [productId, `/api/store-product-images/${productId}?v=${imageRevision}`]);
    }
    await db.query('COMMIT');
    return productId;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}
