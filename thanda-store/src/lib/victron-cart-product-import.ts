import pool from '@/lib/db';
import { victronStockSku } from '@/lib/victron-sku';

type EOrderProduct = Record<string, unknown> & {
  sku?: unknown; description?: unknown; category?: unknown; subcategory?: unknown;
  price?: unknown; currency?: unknown; stock_quantity?: unknown;
  all_stock_by_warehouse?: Record<string, unknown>; enduser_price_zar?: { price?: unknown };
  product_data?: { name?: unknown; category?: unknown; image?: unknown; main_images?: Array<{ url?: unknown }> };
};

function text(value: unknown, fallback = '') { return String(value || fallback).trim(); }
function number(value: unknown) { const result = Number(value); return Number.isFinite(result) ? result : null; }
function stock(product: EOrderProduct) { return number(product.all_stock_by_warehouse?.af_sa_inzuzo) ?? number(product.stock_quantity) ?? 0; }

export async function importVictronCartProducts(skus: string[]) {
  // Retail-packaging article codes end in R. Import the canonical article so
  // the cart cannot create a second planning/stock record for it.
  const requested = [...new Set(skus.map(victronStockSku).filter(Boolean))];
  if (!requested.length) return [];
  const existing = await pool.query<{ sku: string }>('SELECT UPPER(sku) AS sku FROM products WHERE supplier = $1 AND UPPER(sku) = ANY($2)', ['victron', requested]);
  const missing = requested.filter((sku) => !new Set(existing.rows.map((row) => row.sku)).has(sku));
  if (!missing.length) return [];
  if (missing.length > 20) throw new Error('This cart has more than 20 new Victron SKUs. Run the normal Victron catalogue sync first, then upload it again.');

  const apiRoot = (process.env.VICTRON_EORDER_API_ROOT || 'https://eorder.victronenergy.com/api/v1').replace(/\/$/, '');
  const apiKey = process.env.VICTRON_EORDER_API_KEY;
  const discountFactor = Number(process.env.VICTRON_THANDA_DISCOUNT_FACTOR || 0.525);
  if (!apiKey) throw new Error('Victron E-Order API credentials are not configured.');
  const imported: string[] = [];
  for (const sku of missing) {
    const response = await fetch(`${apiRoot}/products/${encodeURIComponent(sku)}/?format=json`, { headers: { Authorization: apiKey, Accept: 'application/json', 'User-Agent': 'ThandaStoreCartImport/1.0' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`Victron could not import ${sku} from E-Order (HTTP ${response.status}).`);
    const product = await response.json() as EOrderProduct;
    if (text(product.sku).toUpperCase() !== sku) throw new Error(`Victron returned an unexpected product while importing ${sku}.`);
    const accountPrice = number(product.price) ?? 0;
    const recommendedRetailExVat = discountFactor > 0 ? Math.round((accountPrice / discountFactor) * 100) / 100 : number(product.enduser_price_zar?.price) ?? 0;
    const productData = product.product_data || {};
    const name = text(product.description || productData.name, sku);
    const imageUrl = text(productData.main_images?.[0]?.url || productData.image);
    const supplierStock = stock(product);
    const category = text(product.category || product.subcategory || productData.category, 'uncategorized');
    const hidden = category.toLowerCase() === 'solar home system';
    const details = {
      originalPrice: recommendedRetailExVat, recommendedRetailExVat, recommendedRetailPriceVatMode: 'ex_vat',
      recommendedRetailSource: 'eorder_price_divided_by_thanda_discount_factor', distributorPriceExVat: accountPrice,
      thandaDiscountFactor: discountFactor, currency: text(product.currency, 'ZAR'), allStockByWarehouse: product.all_stock_by_warehouse || null,
      supplierStockLabel: 'Victron Warehouse ZA', supplierAvailability: supplierStock > 0 ? 'Availability: 3-5 working days' : 'Out of stock / not available',
      hidden, importedFromEOrderCart: true,
    };
    await pool.query(`
      INSERT INTO products (sku, supplier, supplier_item_id, name, price, image_url, category, stock_on_hand, details, last_updated)
      VALUES ($1, 'victron', $1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
      ON CONFLICT (supplier, sku) DO UPDATE SET supplier_item_id = EXCLUDED.supplier_item_id, name = EXCLUDED.name, price = EXCLUDED.price,
        image_url = COALESCE(NULLIF(EXCLUDED.image_url, ''), products.image_url), category = EXCLUDED.category, stock_on_hand = EXCLUDED.stock_on_hand,
        details = products.details || EXCLUDED.details, last_updated = NOW()
    `, [sku, name, accountPrice, imageUrl, category, supplierStock, JSON.stringify(details)]);
    imported.push(sku);
  }
  return imported;
}
