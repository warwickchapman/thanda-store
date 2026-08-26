/**
 * Victron appends R to an article code for retail packaging. It is the same
 * underlying stock item for Thanda's planning purposes.
 */
export function victronStockSku(value: string) {
  const sku = value.trim().toUpperCase();
  return sku.endsWith('R') ? sku.slice(0, -1) : sku;
}
