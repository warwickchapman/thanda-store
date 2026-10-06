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
  return Object.fromEntries(Object.entries(row).filter(([key]) => !['observedAt', 'fingerprint', 'zaStock', 'ignoredUntil'].includes(key)
    && !(row.kind === 'review' && key === 'stock')));
}
export function exclusion(product) {
  const sku = String(product.sku || '').toUpperCase();
  const description = `${product.description || ''} ${product.category || ''} ${product.subcategory || ''}`;
  // The supplier's "Solar panels and cables" category also contains SCA
  // accessories and SLS SolarSense. Only these article prefixes are panels.
  if (/^(SPM|SPP)/.test(sku)) return 'Victron solar panels are excluded in South Africa.';
  const advice = [];
  if (/\b120V\b/i.test(description) && !/\b230V\b/i.test(description)) advice.push('120V-only model: South African eligibility requires review.');
  if (/solar home system/i.test(description)) advice.push('Solar home system: South African eligibility requires review.');
  return advice.length ? advice.join(' ') : null;
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
  return row.kind !== 'review' || (!row.ignoredUntil && Number.isFinite(row.zaStock) && row.zaStock > 0);
}
/** @returns {{reviewAction: 'new'|'price'|'keep'|null, approvalReason: string|null, reviewBlocker: string|null, ignoredUntil: string|null}} */
function reviewFields() {
  return { reviewAction: null, approvalReason: null, reviewBlocker: null, ignoredUntil: null };
}
export function reviewCatalogue({ catalogue, items, successions = [], history = {}, decisions = [], observedAt, now = Date.now() }) {
  const age = now - Date.parse(observedAt);
  if (!catalogue.length || !Number.isFinite(age) || age < -300000 || age > 86400000) throw new Error('A complete E-Order catalogue less than 24 hours old is required.');
  const source = new Map(catalogue.map(p => [String(p.sku).toUpperCase(), p]));
  if (source.size !== catalogue.length) throw new Error('Duplicate E-Order article codes; review blocked.');
  const sourceArticles = new Set([...source.keys()].map(article));
  const decisionBySku = new Map(decisions.map(decision => [`${decision.company}:${decision.sku}`, decision]));
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
      // Only regional/voltage advice can be accepted. Independent hard gates
      // must still run even when the advisory reason would otherwise mask them.
      const advisory = excluded && !/^(SPM|SPP)/.test(sku) ? excluded : null;
      const decision = decisionBySku.get(`${company}:${sku}`);
      const alias = !item && items[company].find(p => article(p.Code) === article(sku));
      const ending = /available\s+until\s+stock\s+0/i.test(product.description || '');
      const base = { company, sku, name: product.description || sku, ...relationships, observedAt,
        listSource: pricing.listSource ?? null, cost: pricing.cost ?? null, list: pricing.list ?? null, proposed: target ?? null,
        itemId: item?.ItemID ?? null, previous: item?.PurchaseDetails?.UnitPrice ?? null,
        stock: item?.QuantityOnHand ?? null, zaStock: zaWarehouseStock(product), eligibleForArchiveReview: false,
        ...reviewFields() };
      let kind = !item ? 'new' : 'price';
      let blocker = (excluded && !advisory ? excluded : null) || pricing.error || (!target ? 'No verified E-Order ZAR list price; Sensible cost cannot be calculated.' : null);
      if (!item && (alias || relationships.replacedBy.length || ending)) blocker ||= alias ? `Retail-packaging alias of ${alias.Code}; review existing item.` : 'Phase-out/replacement item: review before creating.';
      if (item && item.IsPurchased === false) blocker ||= 'Purchasing is disabled in Xero; review manually.';
      if (item && advisory && item.IsPurchased !== true) blocker ||= 'Xero purchasing status is unknown; verify it before accepting this item.';
      if (item && advisory && (typeof item.ItemID !== 'string' || !item.ItemID)) blocker ||= 'Xero item identity is unavailable; verify it before accepting this item.';
      if (!item && !pricing.list) blocker ||= 'A verified list price is required to initialise selling price.';
      const currentCost = item && base.previous != null && Math.round(Number(base.previous) * 100) === Math.round(target * 100);
      let reason = blocker || (decision?.approvedReason === advisory ? null : advisory);
      if (reason) kind = 'review';
      if (kind === 'review') {
        base.reviewAction = advisory && !blocker ? (!item ? 'new' : currentCost ? 'keep' : 'price') : null;
        base.approvalReason = advisory;
        base.reviewBlocker = blocker;
        base.ignoredUntil = Date.parse(decision?.ignoredUntil) > now ? decision.ignoredUntil : null;
      }
      const retired = item && retirementReason({ name: product.description }, product, relationships.replacedBy[0]);
      if (retired) { kind = 'archive'; reason = retired + ' Check remaining stock and open orders before archiving in Xero.'; base.eligibleForArchiveReview = true; }
      if (!reason && currentCost) continue;
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
        cost: null, list: null, proposed: null, eligibleForArchiveReview: Boolean(h?.absentDays >= 2), itemId: item.ItemID, previous: item.PurchaseDetails?.UnitPrice ?? null,
        ...reviewFields() };
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
// The existing audit is also the durable decision record. Approval and ignore
// are separate streams so ignoring a later hard failure cannot erase acceptance.
export async function readReviewDecisions(db) {
  const records = (await db.query(`SELECT DISTINCT ON (company,sku,decision_group)
    company,sku,action,details->>'approvedReason' AS approved_reason,
    CASE WHEN action='review-ignored' THEN created_at + interval '90 days' END AS ignored_until
    FROM (SELECT *,CASE WHEN action='review-approved' THEN 'approval' ELSE 'ignore' END AS decision_group
      FROM victron_catalogue_events WHERE action IN ('review-approved','review-ignored','review-resumed')) decisions
    ORDER BY company,sku,decision_group,id DESC`)).rows;
  const bySku = new Map();
  for (const record of records) {
    const key = `${record.company}:${record.sku}`;
    const decision = bySku.get(key) || { company: record.company, sku: record.sku };
    if (record.action === 'review-approved') decision.approvedReason = record.approved_reason;
    else decision.ignoredUntil = record.ignored_until ? new Date(record.ignored_until).toISOString() : null;
    bySku.set(key, decision);
  }
  return [...bySku.values()];
}
export async function recordReviewDecision(db, actor, row, action) {
  if (!['review-approved','review-ignored','review-resumed'].includes(action)
    || row.kind !== 'review' || !companies.includes(row.company)
    || (action === 'review-approved' && (!row.reviewAction || !row.approvalReason || row.reviewBlocker))) throw new Error('Invalid review decision');
  return (await db.query(`INSERT INTO victron_catalogue_events(actor,action,company,sku,details)
    VALUES($1,$2,$3,$4,$5) RETURNING created_at + interval '90 days' AS ignored_until`,
    [String(actor),action,row.company,row.sku,JSON.stringify({ fingerprint: row.fingerprint,
      approvedReason: action === 'review-approved' ? row.approvalReason : null, reason: row.reason,
      reviewAction: row.reviewAction, previous: row.previous, proposed: row.proposed, list: row.list })])).rows[0];
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
