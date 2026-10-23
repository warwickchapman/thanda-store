import { observeVictronSupplierStock } from './data-freshness.mjs';
import { victronArticleSuccessions } from './victron-sku-family.mjs';

export function retirementReason(product, source, successor) {
  const ending = /available\s+until\s+stock\s+0/i.test(source?.description || product.name || '');
  if (!source) return successor ? `Superseded by ${successor}; absent from the complete E-Order catalogue.`
    : 'Removed from the complete E-Order catalogue; review remaining stock before archiving.';
  const zero = observeVictronSupplierStock(source, new Date().toISOString()).quantity === 0;
  return zero && successor ? `Superseded by ${successor}; E-Order stock is zero.`
    : zero && ending ? 'Available until stock 0: E-Order stock is now zero.' : null;
}

// Called only after the complete, validated catalogue has been fetched. No API calls.
export async function recordCatalogueLifecycle(db, catalogue, observedAt) {
  if (!catalogue.length) throw new Error('Empty catalogue cannot establish retirement');
  const source = new Map(catalogue.map(row => [String(row.sku).toUpperCase(), row]));
  const [products, relationships] = await Promise.all([
    db.query("SELECT sku,name,details FROM products WHERE supplier='victron'"),
    db.query('SELECT predecessor_sku,successor_sku FROM victron_sku_successions'),
  ]);
  const successors = new Map(victronArticleSuccessions(relationships.rows).map(row => [row.predecessor_sku, row.successor_sku]));
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
