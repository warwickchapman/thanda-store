import { enertecPreviewEmails } from './catalogue-access.mjs';
import { catalogueDerivedDetails } from './catalogue-filters.mjs';

export const ENERTEC_CATEGORIES = Object.freeze({
  energizer: 'Energizer', marine: 'Marine & Leisure', ctek: 'CTEK',
});

// Pricing inputs are supplied privately alongside buying costs.
export function enertecGrossMargin(row) {
  const margin = row.grossMarginPercent;
  if (typeof margin !== 'number' || !Number.isFinite(margin) || margin < 0 || margin >= 100) {
    throw new Error(`Invalid Enertec gross margin: ${row.sku}`);
  }
  return margin;
}

export function buildEnertecProducts(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('Enertec source products are required.');
  const seen = new Set();
  return entries.map(row => {
    if (!row || !Object.hasOwn(ENERTEC_CATEGORIES, row.list) || typeof row.sku !== 'string'
      || !/^[A-Z0-9][A-Z0-9/.-]+$/.test(row.sku) || seen.has(row.sku)) throw new Error('Invalid or duplicate Enertec product.');
    seen.add(row.sku);
    if (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 200
      || !Array.isArray(row.sourceRanges) || !row.sourceRanges.length
      || row.sourceRanges.some(value => typeof value !== 'string')
      || typeof row.discontinued !== 'boolean') throw new Error(`Invalid Enertec source metadata: ${row.sku}`);
    if (row.costExVat !== null && (typeof row.costExVat !== 'number' || !Number.isFinite(row.costExVat) || row.costExVat <= 0)) {
      throw new Error(`Invalid Enertec buying price: ${row.sku}`);
    }
    const identityHold = row.priceOnRequest === true;
    const margin = enertecGrossMargin(row);
    const sellingPrice = row.costExVat === null || identityHold ? null : Math.round(row.costExVat / (1 - margin / 100) * 100) / 100;
    const notes = ['Preview pricing. Confirm availability with sales.'];
    if (row.specificationsNeedReview) notes.push('Specifications are awaiting supplier confirmation.');
    if (identityHold) notes.push('Manufacturer article and price to be confirmed.');
    const details = {
      enertecRange: row.list, brand: row.brand, subcategory: row.sourceRanges.join(' / '),
      fixedDealerPrice: true, pricingStatus: sellingPrice === null ? 'unpriced' : 'provisional',
      recommendedRetailExVat: sellingPrice, currency: 'ZAR',
      supplierCostExVat: row.costExVat, enertecGrossMarginPercent: sellingPrice === null ? null : margin,
      enertecPriceListMonth: '2026-10', enertecSource: row.source,
      hidden: row.discontinued, discontinued: row.discontinued,
      supplierStockStatus: 'unknown', supplierStockManaged: false, supplierStockLabel: 'Enertec',
      localStockOnHand: null, xeroStockStatus: 'missing',
      productNotes: notes,
      description: `${row.name}. ${ENERTEC_CATEGORIES[row.list]} range supplied by Enertec. ${notes.join(' ')}`,
      publicResources: row.resources || [],
    };
    const product = {
      supplier: 'enertec', supplier_item_id: row.sku, sku: row.sku, name: row.name,
      category: ENERTEC_CATEGORIES[row.list], price: sellingPrice ?? 0,
      image_url: row.imageUrl || '', stock_on_hand: 0, details,
    };
    product.details = { ...details, ...catalogueDerivedDetails(product) };
    return product;
  });
}

export function summarizeEnertecProducts(products) {
  const visible = products.filter(p => !p.details.hidden);
  return {
    total: products.length, previewVisible: visible.length,
    hiddenDiscontinued: products.filter(p => p.details.hidden).length,
    priceOnRequest: visible.filter(p => p.details.pricingStatus === 'unpriced').length,
    categories: Object.fromEntries(Object.values(ENERTEC_CATEGORIES).map(category => [category, visible.filter(p => p.category === category).length])),
    accounts: enertecPreviewEmails(),
  };
}

export async function saveEnertecProducts(client, products) {
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('enertec-catalogue-seed'))");
    for (const product of products) {
      await client.query(`INSERT INTO products
        (supplier, supplier_item_id, sku, name, category, price, image_url, stock_on_hand, details, last_updated)
        VALUES ('enertec',$1,$2,$3,$4,$5,$6,0,$7::jsonb,NOW())
        ON CONFLICT (supplier,sku) DO UPDATE SET
          supplier_item_id=EXCLUDED.supplier_item_id, name=EXCLUDED.name, category=EXCLUDED.category,
          price=EXCLUDED.price, image_url=COALESCE(NULLIF(EXCLUDED.image_url,''),products.image_url),
          details=products.details || (EXCLUDED.details - 'localStockOnHand' - 'supplierStockStatus'
            - 'supplierStockManaged' - 'xeroStockStatus' - 'hidden')
            || CASE WHEN EXCLUDED.details->>'discontinued'='true' THEN '{"hidden":true}'::jsonb ELSE '{}'::jsonb END,
          last_updated=NOW()`,
      [product.supplier_item_id, product.sku, product.name, product.category, product.price, product.image_url, JSON.stringify(product.details)]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
