import { normalizeSku, replacementContext, skuFamilyResolver } from './sku-successions.mjs';
import { compareProductNames } from './catalogue-search-order.mjs';

const literalSku = (value) => String(value || '').trim().toUpperCase();
const supplierName = (value) => String(value || '').trim().toLowerCase();
const orderable = (product) => Number(product.details?.localStockOnHand) > 0 || Number(product.stock_on_hand) > 0;

// The public range and authenticated Home use the same rolling calendar year.
export function favouritesWindowStart(now = Date.now()) {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  return cutoff.toISOString().slice(0, 10);
}

// Invoice history has an ItemCode but no supplier. Ambiguous cross-brand codes
// cannot safely be attributed to a replacement family, so they are omitted.
function salesByFamily(history, identityProducts, successions, now) {
  const familyFor = skuFamilyResolver(successions);
  // Public eligibility can narrow representatives without erasing a known
  // cross-brand ItemCode collision from the source catalogue.
  const candidates = [...identityProducts.map((product) => ({ supplier: supplierName(product.supplier), sku: product.sku })),
    ...successions.flatMap((row) => [row.predecessor_sku, row.successor_sku].map((sku) => ({ supplier: supplierName(row.supplier), sku })))];
  const suppliersBySku = new Map();
  const victronArticles = new Set();
  for (const candidate of candidates) {
    const sku = literalSku(candidate.sku);
    const suppliers = suppliersBySku.get(sku) || new Set();
    suppliers.add(candidate.supplier);
    suppliersBySku.set(sku, suppliers);
    if (candidate.supplier === 'victron') victronArticles.add(normalizeSku('victron', sku));
  }
  const groups = new Map();
  for (const row of history) {
    const sku = literalSku(row.sku);
    const suppliers = new Set(suppliersBySku.get(sku) || []);
    if (victronArticles.has(normalizeSku('victron', sku))) suppliers.add('victron');
    if (suppliers.size !== 1) continue;
    const supplier = [...suppliers][0];
    const invoiceDate = new Date(row.invoice_date);
    if (Number.isNaN(invoiceDate.getTime())) continue;
    const date = invoiceDate.toISOString().slice(0, 10);
    const family = familyFor(supplier, sku);
    const group = groups.get(family) || { supplier, invoiceIds: new Set(), units: 0, lastOrdered: '', recent90: false, recent180: false };
    group.invoiceIds.add(String(row.invoice_id));
    group.units += Number(row.quantity) || 0;
    if (date > group.lastOrdered) group.lastOrdered = date;
    const ageDays = (now - invoiceDate.getTime()) / 86_400_000;
    if (ageDays <= 90) group.recent90 = true;
    if (ageDays <= 180) group.recent180 = true;
    groups.set(family, group);
  }
  return groups;
}

// Only relative order leaves the server, never customer history or unit totals.
export function popularSearchProductIds(history, products, successions, now = Date.now()) {
  const familyFor = skuFamilyResolver(successions);
  const groups = salesByFamily(history, products, successions, now);
  // History quantities are NUMERIC(14,3); do not rank floating-point residue as a sale.
  const units = product => Math.round((groups.get(familyFor(product.supplier, product.sku))?.units || 0) * 1000) / 1000;
  return products.filter(product => units(product) > 0)
    .sort((left, right) => units(right) - units(left) || compareProductNames(left, right))
    .map(product => product.id);
}

export function rankedFavouriteProducts(history, products, successions, rankedByFrequency, now = Date.now(), limit = 20, identityProducts = products) {
  const familyFor = skuFamilyResolver(successions);
  const groups = salesByFamily(history, identityProducts, successions, now);
  const families = new Map();
  for (const product of products) {
    const family = familyFor(product.supplier, product.sku);
    const members = families.get(family) || [];
    members.push(product);
    families.set(family, members);
  }
  return [...groups.entries()].flatMap(([family, group]) => {
    const members = [...(families.get(family) || [])].sort((left, right) => {
      const older = (product) => replacementContext(successions, product.supplier, product.sku).replacedBy.length > 0;
      return Number(older(left)) - Number(older(right));
    });
    const expected = successions.filter((row) => familyFor(row.supplier, row.predecessor_sku) === family
      && replacementContext(successions, row.supplier, row.successor_sku).replacedBy.length === 0)
      .map((row) => normalizeSku(row.supplier, row.successor_sku));
    const current = new Set(members.map((product) => normalizeSku(product.supplier, product.sku)));
    if (!members.some(orderable) && expected.some((sku) => !current.has(sku))) return [];
    const product = members.find(orderable) || members[0];
    if (!product) return [];
    const score = rankedByFrequency ? group.invoiceIds.size * 100 + (group.recent90 ? 20 : group.recent180 ? 10 : 0) : group.units;
    return [{ product, score, lastOrdered: group.lastOrdered, units: group.units }];
  }).sort((left, right) => right.score - left.score || right.lastOrdered.localeCompare(left.lastOrdered) || right.units - left.units)
    .slice(0, limit).map((row) => row.product);
}
