import { createHash } from 'node:crypto';
import { prices } from './victron-pricing.mjs';
import { observeVictronSupplierStock } from './data-freshness.mjs';

export function retirementReason(product, source, successor) {
  const ending = /available\s+until\s+stock\s+0/i.test(source?.description || product.name || '');
  if (!source) return successor ? `Superseded by ${successor}; absent from the complete E-Order catalogue.`
    : ending ? 'Discontinued: absent from the complete E-Order catalogue.' : null;
  const zero = observeVictronSupplierStock(source, new Date().toISOString()).quantity === 0;
  return zero && successor ? `Superseded by ${successor}; E-Order stock is zero.`
    : zero && ending ? 'Available until stock 0: E-Order stock is now zero.' : null;
}

export function itemCreationPreview(product, successions, now = Date.now()) {
  const d = product.details || {};
  const successor = successions.find(row => row.predecessor_sku === product.sku)?.successor_sku;
  let reason = null;
  if (product.supplier !== 'victron') reason = 'Only Victron product creation is supported.';
  else if (d.xeroStockStatus !== 'missing') reason = 'This item is not missing from Xero. Reload Data health.';
  else if (product.stockReview?.decision) reason = 'Undo the saved stocking decision before creating this item.';
  else if (d.purchasingRetiredReason) reason = d.purchasingRetiredReason;
  else if (d.cataloguePresent !== true) reason = successor ? `Review successor ${successor}; this SKU has no current catalogue evidence.` : 'Wait for a successful E-Order catalogue sync to verify this item.';
  const age = now - Date.parse(d.catalogueObservedAt || '');
  if (!reason && (!Number.isFinite(age) || age < -300000 || age > 86400000)) reason = 'Refresh the E-Order catalogue: price evidence must be less than 24 hours old.';
  if (!reason && d.catalogueCurrency !== 'ZAR') reason = 'A verified ZAR cost price is required.';
  const cost = Number(d.cataloguePrice);
  if (!reason && (d.cataloguePrice == null || !Number.isFinite(cost) || cost <= 0)) reason = 'No valid E-Order cost price. Review the catalogue sync.';
  const pricing = prices({ price: d.cataloguePrice, currency: d.catalogueCurrency, enduser_price_zar: { price: d.catalogueListPrice } });
  if (!reason && pricing.error) reason = pricing.error;
  if (!reason && /^(SPM|SPP)/i.test(product.sku)) reason = 'Victron solar panels are excluded in South Africa.';
  const cents = Math.round(cost * 100);
  const selling = pricing.list ?? null;
  const payload = { code: product.sku, name: product.name, cost: cents / 100, list: selling, action: 'new', expectedItemId: null, expectedCost: null, observedAt: d.catalogueObservedAt };
  return { eligible: !reason, reason, cost: cents / 100, selling, listSource: pricing.listSource ?? null, successor: successor || null,
    observedAt: d.catalogueObservedAt || null, payload,
    fingerprint: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
}

// Called only after the complete, validated catalogue has been fetched. No API calls.
export async function recordCatalogueLifecycle(db, catalogue, observedAt) {
  if (!catalogue.length) throw new Error('Empty catalogue cannot establish retirement');
  const source = new Map(catalogue.map(row => [String(row.sku).toUpperCase(), row]));
  const [products, relationships] = await Promise.all([
    db.query("SELECT sku,name,details FROM products WHERE supplier='victron'"),
    db.query('SELECT predecessor_sku,successor_sku FROM victron_sku_successions'),
  ]);
  const successors = new Map(relationships.rows.map(row => [row.predecessor_sku, row.successor_sku]));
  for (const product of products.rows) {
    const row = source.get(product.sku);
    const reason = retirementReason(product, row, successors.get(product.sku));
    await db.query(`UPDATE products SET details=details || $2::jsonb WHERE supplier='victron' AND sku=$1`, [product.sku, JSON.stringify({
      cataloguePresent: Boolean(row), catalogueObservedAt: observedAt,
      catalogueCurrency: row?.currency ?? null, cataloguePrice: row?.price ?? null, catalogueListPrice: row?.enduser_price_zar?.price ?? null,
      purchasingRetiredReason: reason,
      purchasingRetiredAt: reason ? product.details?.purchasingRetiredAt || observedAt : null,
    })]);
  }
}
