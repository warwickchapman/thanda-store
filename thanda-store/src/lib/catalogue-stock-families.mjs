import { localStockObservation, supplierStockObservation } from './data-freshness.mjs';
import { stockSku, victronArticleSuccessions, victronSkuFamilyResolver } from './victron-sku-family.mjs';

const code = value => String(value || '').trim().toUpperCase();
const hidden = row => row.details?.hidden === true || row.details?.hidden === 'true';

function stockSummary(articles, rows, observe, { supplier = false, now = Date.now() } = {}) {
  let total = 0;
  let observed = 0;
  let missing = false;
  for (const article of articles) {
    const aliases = rows.filter(row => stockSku(row.sku) === article)
      .sort((a, b) => Number(code(a.sku).endsWith('R')) - Number(code(b.sku).endsWith('R')));
    // Supplier absence means it is no longer offered, not physical zero.
    // Omit a removed article from an otherwise current family's availability.
    if (supplier && aliases.length && aliases.every(row => row.details?.cataloguePresent === false)) continue;
    const observation = aliases.filter(row => !supplier || row.details?.cataloguePresent !== false)
      .map(observe).find(value => value.quantity !== null && Date.parse(value.observedAt) <= now + 300_000);
    if (!observation) { missing = true; continue; }
    total += observation.quantity;
    observed++;
  }
  return {
    status: !observed ? 'unknown' : missing ? 'partial' : 'known',
    // A positive subtotal is a lower bound, never an exact total. Partial zero
    // is unknown: it cannot establish that no stock is available.
    quantity: !observed || (missing && total === 0) ? null : total,
  };
}

/**
 * One customer listing per confirmed Victron replacement family. Inputs and
 * accounting identities remain untouched; literal rows are still used by carts
 * and Xero commands. Retail aliases contribute one observation per article.
 */
export function catalogueStockFamilies(products, successions) {
  const edges = victronArticleSuccessions(successions);
  const familyFor = victronSkuFamilyResolver(edges);
  const groups = new Map();
  for (const row of products) {
    if (String(row.supplier).toLowerCase() !== 'victron') continue;
    const family = familyFor(row.sku);
    const members = groups.get(family) || [];
    members.push(row);
    groups.set(family, members);
  }
  const predecessors = new Set(edges.map(row => stockSku(row.predecessor_sku)));
  const result = [];
  const emitted = new Set();
  for (const row of products) {
    if (String(row.supplier).toLowerCase() !== 'victron') {
      if (!hidden(row)) result.push({ row, stock: null });
      continue;
    }
    const family = familyFor(row.sku);
    if (emitted.has(family)) continue;
    emitted.add(family);
    const members = groups.get(family);
    const visible = members.filter(member => !hidden(member));
    if (!visible.length) continue;
    const relations = edges.filter(edge => familyFor(edge.predecessor_sku) === family);
    // Do not change unrelated retail-only listings in this replacement policy.
    if (!relations.length) {
      result.push(...visible.filter(member => member.details?.cataloguePresent !== false
        || Number(localStockObservation(member).quantity) > 0).map(member => ({ row: member, stock: null })));
      continue;
    }
    if (members.every(member => member.details?.cataloguePresent === false)
      && !members.some(member => Number(localStockObservation(member).quantity) > 0)) continue;
    const depths = new Map();
    const visit = (sku, seen = new Set()) => {
      if (seen.has(sku)) return 0;
      const before = relations.filter(edge => stockSku(edge.successor_sku) === sku);
      return before.length ? 1 + Math.max(...before.map(edge => visit(stockSku(edge.predecessor_sku), new Set([...seen, sku])))) : 0;
    };
    for (const member of visible) depths.set(member.sku, visit(stockSku(member.sku)));
    const representative = [...visible].sort((a, b) =>
      Number(b.details?.cataloguePresent !== false) - Number(a.details?.cataloguePresent !== false)
      || Number(predecessors.has(stockSku(a.sku))) - Number(predecessors.has(stockSku(b.sku)))
      || depths.get(b.sku) - depths.get(a.sku)
      || Number(code(a.sku).endsWith('R')) - Number(code(b.sku).endsWith('R'))
      || code(a.sku).localeCompare(code(b.sku)))[0];
    const skus = [...new Set([...members.map(member => code(member.sku)), ...relations.flatMap(edge => [code(edge.predecessor_sku), code(edge.successor_sku)])])].sort();
    const articles = [...new Set(skus.map(stockSku))];
    result.push({ row: representative, stock: {
      skus,
      local: stockSummary(articles, members, localStockObservation),
      supplier: stockSummary(articles, members, supplierStockObservation, { supplier: true }),
    } });
  }
  return result;
}

export function withCatalogueFamilyStock(product, stock) {
  if (!stock) return product;
  return { ...product, stock_on_hand: stock.supplier.quantity, details: {
    ...product.details,
    localStockOnHand: stock.local.quantity,
    stockFamilySkus: stock.skus,
    stockFamilyLocalStatus: stock.local.status,
    stockFamilySupplierStatus: stock.supplier.status,
    previousSkus: [...new Set([...(product.details?.previousSkus || []), ...stock.skus.filter(sku => sku !== code(product.sku))])],
  } };
}
