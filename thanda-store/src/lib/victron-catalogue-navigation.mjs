// Only selects a saved row. Opening a diagnostic link never compares evidence
// again, accepts eligibility advice or dispatches a product command.
export function linkedCatalogueItem(search, rows) {
  const params = new URLSearchParams(search);
  const company = params.get('company') || 'thanda-solar';
  const sku = (params.get('sku') || '').trim().toUpperCase();
  if (!['thanda-solar', 'sensible-solar'].includes(company) || !/^[A-Z0-9-]{1,30}$/.test(sku)) return null;
  const row = rows.find(row => row.company === company && row.sku === sku);
  return { company, sku, kind: row?.kind || 'review' };
}
