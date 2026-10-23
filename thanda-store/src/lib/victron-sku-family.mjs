export function stockSku(value) {
  const sku = String(value || '').trim().toUpperCase();
  return sku.endsWith('R') ? sku.slice(0, -1) : sku;
}

// Replacement markers must name an article code. Product names such as
// "If 0, order Cerbo GX MK2" are advice, not a succession to an article CERBO.
export function isVictronArticleCode(value) {
  const sku = String(value || '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9-]*$/.test(sku) && /\d/.test(sku);
}

export function victronArticleSuccessions(successions = []) {
  return successions.filter(row => (!row.supplier || String(row.supplier).toLowerCase() === 'victron')
    && isVictronArticleCode(row.predecessor_sku) && isVictronArticleCode(row.successor_sku));
}

export function successorSkuFromDescription(description) {
  const match = String(description || '').match(/\bif\s+0\s*,?\s*order\s+([A-Z0-9-]+)\b/i);
  return match && isVictronArticleCode(match[1]) ? match[1].toUpperCase() : null;
}

export function skuReplacementContext(successions, sku) {
  successions = victronArticleSuccessions(successions);
  const article = stockSku(sku);
  return {
    replaces: [...new Set(successions.filter(row => stockSku(row.successor_sku) === article && stockSku(row.predecessor_sku) !== article).map(row => row.predecessor_sku))].sort(),
    replacedBy: [...new Set(successions.filter(row => stockSku(row.predecessor_sku) === article && stockSku(row.successor_sku) !== article).map(row => row.successor_sku))].sort(),
  };
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
  for (const succession of victronArticleSuccessions(successions)) {
    const predecessorRoot = find(stockSku(succession.predecessor_sku));
    const successorRoot = find(stockSku(succession.successor_sku));
    if (predecessorRoot !== successorRoot) parent.set(successorRoot, predecessorRoot);
  }
  return (sku) => find(stockSku(sku));
}

export function predecessorSkusForFamily(successions, family) {
  successions = victronArticleSuccessions(successions);
  const resolveFamily = victronSkuFamilyResolver(successions);
  return [...new Set(successions
    .filter((succession) => resolveFamily(succession.predecessor_sku) === family)
    .map((succession) => String(succession.predecessor_sku).trim().toUpperCase()))].sort();
}

export function familyMemberSkus(successions, sku) {
  successions = victronArticleSuccessions(successions);
  const resolveFamily = victronSkuFamilyResolver(successions);
  const family = resolveFamily(sku);
  return [...new Set([
    String(sku).trim().toUpperCase(),
    ...successions.flatMap((succession) => [succession.predecessor_sku, succession.successor_sku])
      .filter((candidate) => resolveFamily(candidate) === family)
      .map((candidate) => String(candidate).trim().toUpperCase()),
  ])].sort();
}
