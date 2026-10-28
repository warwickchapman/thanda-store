const names = new Intl.Collator('en-ZA', { sensitivity: 'base', numeric: true });

export function compareProductNames(left, right) {
  return names.compare(left.name || '', right.name || '')
    || names.compare(left.sku || '', right.sku || '') || Number(left.id) - Number(right.id);
}

export function sortSearchProducts(products, popularProductIds = []) {
  const ranks = new Map(popularProductIds.map((id, index) => [id, index]));
  return [...products].sort((left, right) =>
    (ranks.get(left.id) ?? Infinity) - (ranks.get(right.id) ?? Infinity)
    || compareProductNames(left, right));
}
