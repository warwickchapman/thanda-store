// Only selects a saved row or category. Opening a diagnostic link never
// compares evidence again, accepts eligibility advice or dispatches a command.
export function linkedCatalogueItem(search, rows) {
  const params = new URLSearchParams(search);
  const company = params.get('company') || 'thanda-solar';
  const sku = (params.get('sku') || '').trim().toUpperCase();
  const requestedKind = params.get('kind');
  if (!['thanda-solar', 'sensible-solar'].includes(company)
    || (sku && !/^[A-Z0-9-]{1,30}$/.test(sku))
    || (requestedKind && !['price', 'selling', 'new', 'review', 'archive'].includes(requestedKind))) return null;
  if (!sku && !requestedKind) return null;
  const matching = rows.filter(row => row.company === company && row.sku === sku);
  const row = matching.find(row => row.kind === requestedKind) || matching[0];
  return { company, sku, kind: row?.kind || requestedKind || 'review' };
}
