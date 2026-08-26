function stockSku(value) {
  const sku = String(value || '').trim().toUpperCase();
  return sku.endsWith('R') ? sku.slice(0, -1) : sku;
}

/**
 * Returns a canonical key for a Victron replacement family. The predecessor
 * is the stable key, so historical sales and current successor stock group
 * together. Retail (`R`) packaging is part of the same stock item.
 */
export function victronSkuFamilyResolver(successions) {
  const parent = new Map();
  const find = (sku) => {
    const current = parent.get(sku) || sku;
    if (current === sku) return sku;
    const root = find(current);
    parent.set(sku, root);
    return root;
  };
  for (const succession of successions) {
    const predecessorRoot = find(stockSku(succession.predecessor_sku));
    const successorRoot = find(stockSku(succession.successor_sku));
    if (predecessorRoot !== successorRoot) parent.set(successorRoot, predecessorRoot);
  }
  return (sku) => find(stockSku(sku));
}

export function predecessorSkusForFamily(successions, family) {
  const resolveFamily = victronSkuFamilyResolver(successions);
  return [...new Set(successions
    .filter((succession) => resolveFamily(succession.predecessor_sku) === family)
    .map((succession) => String(succession.predecessor_sku).trim().toUpperCase()))].sort();
}

export function familyMemberSkus(successions, sku) {
  const resolveFamily = victronSkuFamilyResolver(successions);
  const family = resolveFamily(sku);
  return [...new Set([
    String(sku).trim().toUpperCase(),
    ...successions.flatMap((succession) => [succession.predecessor_sku, succession.successor_sku])
      .filter((candidate) => resolveFamily(candidate) === family)
      .map((candidate) => String(candidate).trim().toUpperCase()),
  ])].sort();
}
