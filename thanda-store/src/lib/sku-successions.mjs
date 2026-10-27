import { localStockObservation, supplierStockObservation } from './data-freshness.mjs';
import { stockSku, victronSkuFamilyResolver, victronArticleSuccessions } from './victron-sku-family.mjs';

const supplierName = (value) => String(value || '').trim().toLowerCase();
const literalSku = (value) => String(value || '').trim().toUpperCase();
const hidden = (product) => product.details?.hidden === true || product.details?.hidden === 'true';
const usableSuccessions = rows => rows.filter(row => supplierName(row.supplier) !== 'victron'
  || victronArticleSuccessions([row]).length);

// Retail packaging is an alias only for Victron. Other brands retain the
// complete article code, including any final R.
export function normalizeSku(supplier, sku) {
  return supplierName(supplier) === 'victron' ? stockSku(sku) : literalSku(sku);
}

export async function loadSkuSuccessions(db) {
  const groups = await Promise.all(['victron', 'renogy'].map(async (supplier) => {
    try {
      const result = await db.query(`SELECT predecessor_sku, successor_sku FROM ${supplier}_sku_successions`);
      return usableSuccessions(result.rows.map((row) => ({ ...row, supplier })));
    } catch (error) {
      // Each supplier is independent during its first deployment/import.
      if (error.code === '42P01') return [];
      throw error;
    }
  }));
  return groups.flat();
}

export function skuFamilyResolver(successions) {
  const victron = victronSkuFamilyResolver(successions.filter((row) => supplierName(row.supplier) === 'victron'));
  const parent = new Map();
  const find = (key) => {
    const current = parent.get(key) || key;
    if (current === key) return key;
    const root = find(current);
    parent.set(key, root);
    return root;
  };
  const identity = (supplier, sku) => `${supplierName(supplier)}:${normalizeSku(supplier, sku)}`;
  for (const row of successions) {
    if (supplierName(row.supplier) === 'victron') continue;
    const predecessor = find(identity(row.supplier, row.predecessor_sku));
    const successor = find(identity(row.supplier, row.successor_sku));
    if (predecessor !== successor) parent.set(successor, predecessor);
  }
  return (supplier, sku) => supplierName(supplier) === 'victron'
    ? `victron:${victron(sku)}` : find(identity(supplier, sku));
}

export function familyMemberSkus(successions, supplier, sku) {
  successions = usableSuccessions(successions);
  const familyFor = skuFamilyResolver(successions);
  const family = familyFor(supplier, sku);
  return [...new Set([
    literalSku(sku),
    ...successions.filter((row) => supplierName(row.supplier) === supplierName(supplier))
      .flatMap((row) => [row.predecessor_sku, row.successor_sku])
      .filter((candidate) => familyFor(supplier, candidate) === family).map(literalSku),
  ])].sort();
}

export function replacementContext(successions, supplier, sku) {
  successions = usableSuccessions(successions);
  const article = normalizeSku(supplier, sku);
  const rows = successions.filter((row) => supplierName(row.supplier) === supplierName(supplier));
  return {
    replaces: [...new Set(rows.filter((row) => normalizeSku(supplier, row.successor_sku) === article
      && normalizeSku(supplier, row.predecessor_sku) !== article).map((row) => literalSku(row.predecessor_sku)))].sort(),
    replacedBy: [...new Set(rows.filter((row) => normalizeSku(supplier, row.predecessor_sku) === article
      && normalizeSku(supplier, row.successor_sku) !== article).map((row) => literalSku(row.successor_sku)))].sort(),
  };
}

// Directed traversal, newest first. Existing intermediate codes remain useful
// when a newer successor has not yet reached the stored catalogue.
export function successorSkus(successions, supplier, sku) {
  successions = usableSuccessions(successions);
  const rows = successions.filter((row) => supplierName(row.supplier) === supplierName(supplier));
  const start = normalizeSku(supplier, sku);
  const depths = new Map([[start, 0]]);
  const literals = new Map();
  const queue = [start];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    for (const row of rows.filter((candidate) => normalizeSku(supplier, candidate.predecessor_sku) === current)) {
      const next = normalizeSku(supplier, row.successor_sku);
      if (depths.has(next)) continue;
      depths.set(next, depths.get(current) + 1);
      literals.set(next, literalSku(row.successor_sku));
      queue.push(next);
    }
  }
  const predecessors = new Set(rows.map((row) => normalizeSku(supplier, row.predecessor_sku)));
  return [...literals.keys()].sort((left, right) => Number(predecessors.has(left)) - Number(predecessors.has(right))
    || depths.get(right) - depths.get(left) || left.localeCompare(right)).map((key) => literals.get(key));
}

export function productHasStock(product) {
  // A removed supplier article can still be sold from real owned stock, but
  // its retained historical supplier balance is not current availability.
  return Number(localStockObservation(product).quantity) > 0
    || (product.details?.cataloguePresent !== false && Number(supplierStockObservation(product).quantity) > 0);
}

/** Select an original row; stock, prices and specifications never move SKUs. */
export function chooseFulfilmentProduct(requested, products, successions, { allowHiddenFamilyStock = false } = {}) {
  successions = usableSuccessions(successions);
  if (!requested) return null;
  const supplier = supplierName(requested.supplier);
  const familyFor = skuFamilyResolver(successions);
  const family = familyFor(supplier, requested.sku);
  const includeHidden = allowHiddenFamilyStock && supplier === 'victron'
    && successions.some(row => supplierName(row.supplier) === supplier
      && familyFor(supplier, row.predecessor_sku) === family);
  if (hidden(requested) && !includeHidden) return null;
  if (!['victron', 'renogy'].includes(supplier)) return requested;
  const rows = products.filter((row) => supplierName(row.supplier) === supplier
    && (includeHidden || !hidden(row)) && familyFor(supplier, row.sku) === family);
  // Hidden stock is available only through a real visible member of its
  // confirmed family. This does not make hidden products independently public.
  if (includeHidden && !rows.some(row => !hidden(row))) return null;
  const edges = successions.filter((row) => supplierName(row.supplier) === supplier);
  const depths = new Map([[normalizeSku(supplier, requested.sku), 0]]);
  const queue = [...depths.keys()];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    for (const edge of edges) {
      const old = normalizeSku(supplier, edge.predecessor_sku);
      const next = normalizeSku(supplier, edge.successor_sku);
      const other = old === current ? next : next === current ? old : null;
      if (other === null || depths.has(other)) continue;
      depths.set(other, depths.get(current) + 1);
      queue.push(other);
    }
  }
  const predecessors = new Set(edges.map((row) => normalizeSku(supplier, row.predecessor_sku)));
  const nearest = (left, right) => (depths.get(normalizeSku(supplier, left.sku)) ?? Infinity)
    - (depths.get(normalizeSku(supplier, right.sku)) ?? Infinity) || left.sku.localeCompare(right.sku);
  const owned = rows.filter((row) => Number(localStockObservation(row).quantity) > 0);
  // Sell owned predecessors first, then other owned family stock. A supplier
  // balance on an older code must not displace an article already held here.
  return owned.filter((row) => predecessors.has(normalizeSku(supplier, row.sku))).sort(nearest)[0]
    || owned.sort(nearest)[0]
    || rows.filter((row) => predecessors.has(normalizeSku(supplier, row.sku)) && productHasStock(row)).sort(nearest)[0]
    || rows.filter((row) => !predecessors.has(normalizeSku(supplier, row.sku))).sort(nearest)[0]
    || requested;
}
