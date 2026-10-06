import { createHash } from 'node:crypto';
import { prices } from './victron-pricing.mjs';
export { prices } from './victron-pricing.mjs';
import { retirementReason } from './xero-item-create.mjs';
import { skuReplacementContext, stockSku as article } from './victron-sku-family.mjs';

export const companies = ['thanda-solar', 'sensible-solar'];
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// A cost approval concerns this exact item and before/after cost. Stock,
// descriptions and observation timestamps can refresh without changing it.
// Command IDs are generated separately when an operator submits an action.
function comparison(row) {
  if (row.kind === 'price') {
    const { company, sku, kind, itemId, previous, proposed } = row;
    return { company, sku, kind, itemId, previous, proposed };
  }
  return Object.fromEntries(Object.entries(row).filter(([key]) => !['observedAt', 'fingerprint', 'zaStock'].includes(key)));
}
export function exclusion(product) {
  const sku = String(product.sku || '').toUpperCase();
  const description = `${product.description || ''} ${product.category || ''} ${product.subcategory || ''}`;
  // The supplier's "Solar panels and cables" category also contains SCA
  // accessories and SLS SolarSense. Only these article prefixes are panels.
  if (/^(SPM|SPP)/.test(sku)) return 'Victron solar panels are excluded in South Africa.';
  if (/\b120V\b/i.test(description) && !/\b230V\b/i.test(description)) return '120V-only model: South African eligibility requires review.';
  if (/solar home system/i.test(description)) return 'Solar home system: South African eligibility requires review.';
  return null;
}
// Review priority is literal-SKU warehouse evidence, not company stock or a
// replacement/retail family's total. Other warehouses cannot establish ZA stock.
export function zaWarehouseStock(product) {
  const value = product?.all_stock_by_warehouse?.af_sa_inzuzo;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim()))) return null;
  const quantity = Number(value);
  return Number.isFinite(quantity) && quantity >= 0 ? quantity : null;
}
export function needsAttention(row) {
  return row.kind !== 'review' || (Number.isFinite(row.zaStock) && row.zaStock > 0);
}
export function reviewCatalogue({ catalogue, items, successions = [], history = {}, observedAt, now = Date.now() }) {
  const age = now - Date.parse(observedAt);
  if (!catalogue.length || !Number.isFinite(age) || age < -300000 || age > 86400000) throw new Error('A complete E-Order catalogue less than 24 hours old is required.');
  const source = new Map(catalogue.map(p => [String(p.sku).toUpperCase(), p]));
  if (source.size !== catalogue.length) throw new Error('Duplicate E-Order article codes; review blocked.');
  const sourceArticles = new Set([...source.keys()].map(article));
  const rows = [];
  for (const company of companies) {
    if (!Array.isArray(items[company])) throw new Error(`Complete Xero items are required for ${company}.`);
    const existing = new Map(items[company].map(p => [p.Code, p]));
    for (const [sku, product] of source) {
      const item = existing.get(sku);
      const relationships = skuReplacementContext(successions, sku);
      const pricing = prices(product);
      const target = company === 'thanda-solar' ? pricing.cost : pricing.sensible;
      const excluded = exclusion(product);
      const alias = !item && items[company].find(p => article(p.Code) === article(sku));
      const ending = /available\s+until\s+stock\s+0/i.test(product.description || '');
      const base = { company, sku, name: product.description || sku, ...relationships, observedAt,
        listSource: pricing.listSource ?? null, cost: pricing.cost ?? null, list: pricing.list ?? null, proposed: target ?? null,
        itemId: item?.ItemID ?? null, previous: item?.PurchaseDetails?.UnitPrice ?? null,
        stock: item?.QuantityOnHand ?? null, zaStock: zaWarehouseStock(product), eligibleForArchiveReview: false };
      let kind = !item ? 'new' : 'price';
      let reason = excluded || pricing.error || (!target ? 'No verified E-Order ZAR list price; Sensible cost cannot be calculated.' : null);
      if (!item && (alias || relationships.replacedBy.length || ending)) reason ||= alias ? `Retail-packaging alias of ${alias.Code}; review existing item.` : 'Phase-out/replacement item: review before creating.';
      if (item && item.IsPurchased === false) reason ||= 'Purchasing is disabled in Xero; review manually.';
      if (!item && !pricing.list) reason ||= 'A verified list price is required to initialise selling price.';
      if (reason) kind = 'review';
      const retired = item && retirementReason({ name: product.description }, product, relationships.replacedBy[0]);
      if (retired) { kind = 'archive'; reason = retired + ' Check remaining stock and open orders before archiving in Xero.'; base.eligibleForArchiveReview = true; }
      if (!reason && item && Math.round(Number(base.previous) * 100) === Math.round(target * 100) && base.previous != null) continue;
      const row = { ...base, kind, reason };
      rows.push({ ...row, fingerprint: fingerprint(comparison(row)) });
    }
    // Literal SKU prices must not migrate to a successor. Relationships are context,
    // while retail aliases suppress accidental duplicate creation above.
    for (const item of items[company]) {
      const sku = item.Code;
      if (sourceArticles.has(article(sku)) || !(/\bVictron\b/i.test(`${item.Name || ''} ${item.Description || ''} ${item.PurchaseDescription || ''}`.trim()) || history[sku])) continue;
      const h = history[sku];
      const reason = h?.absentDays >= 2 ? 'Absent on at least two complete daily E-Order observations. Check remaining stock and open orders in Xero before archiving.' : 'Missing from E-Order; awaiting a second complete daily observation.';
      const base = { company, sku, name: item.Name || sku, kind: 'archive', reason, observedAt,
        ...skuReplacementContext(successions, sku), stock: item.QuantityOnHand ?? null,
        cost: null, list: null, proposed: null, eligibleForArchiveReview: Boolean(h?.absentDays >= 2), itemId: item.ItemID, previous: item.PurchaseDetails?.UnitPrice ?? null };
      rows.push({ ...base, fingerprint: fingerprint(comparison(base)) });
    }
  }
  return rows.sort((a,b) => a.company.localeCompare(b.company)
    || Number(b.kind === 'review' && needsAttention(b)) - Number(a.kind === 'review' && needsAttention(a))
    || a.sku.localeCompare(b.sku));
}

export async function ensureReviewSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS victron_catalogue_evidence (
    id boolean PRIMARY KEY DEFAULT true CHECK(id), observed_at timestamptz NOT NULL, products jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS victron_catalogue_review (
    id boolean PRIMARY KEY DEFAULT true CHECK(id), checked_at timestamptz, observed_at timestamptz,
    rows jsonb NOT NULL DEFAULT '[]', history jsonb NOT NULL DEFAULT '{}', history_day date,
    error text, signature text, acknowledged_signature text);
    CREATE TABLE IF NOT EXISTS victron_catalogue_events (
    id bigserial PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), actor text NOT NULL,
    action text NOT NULL, company text, sku text, details jsonb NOT NULL);
    INSERT INTO victron_catalogue_review(id) VALUES(true) ON CONFLICT DO NOTHING`);
}
export async function saveCatalogueEvidence(db, products, observedAt) {
  if (!products.length || new Set(products.map(p => p.sku)).size !== products.length) throw new Error('Incomplete catalogue evidence');
  await ensureReviewSchema(db);
  await db.query(`INSERT INTO victron_catalogue_evidence(id,observed_at,products) VALUES(true,$1,$2)
    ON CONFLICT(id) DO UPDATE SET observed_at=EXCLUDED.observed_at,products=EXCLUDED.products`, [observedAt, JSON.stringify(products)]);
}
export function advanceHistory(history, catalogue, day, successions = [], observedAt = day) {
  const next = structuredClone(history);
  const present = new Set(catalogue.map(p => String(p.sku).toUpperCase()));
  for (const [sku, value] of Object.entries(next)) {
    if (value.day !== day) next[sku] = { day, absentDays: present.has(sku) ? 0 : value.absentDays + 1, absentSince: present.has(sku) ? null : value.absentSince || day };
    else if (present.has(sku)) next[sku] = { day, absentDays: 0, absentSince: null };
  }
  for (const product of catalogue) {
    const sku = String(product.sku).toUpperCase();
    const context = skuReplacementContext(successions, sku);
    const retired = retirementReason({ name: product.description }, product, context.replacedBy[0]);
    next[sku] = { day, absentDays: 0, absentSince: null, retiredSince: retired ? history[sku]?.retiredSince || observedAt : null };
  }
  return next;
}
// Silence unstocked review rows, but keep them in the saved comparison. A newly
// stocked SKU re-enters this signature on the next daily/manual comparison.
// Neither observation timestamps nor positive warehouse quantity churn repeats alerts.
export function changeSignature(rows, error = null) {
  return fingerprint({ error, rows: rows.filter(needsAttention).map(comparison) });
}
