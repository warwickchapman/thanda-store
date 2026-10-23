import { stockSku, victronArticleSuccessions } from './victron-sku-family.mjs';

const COMPANY = 'thanda-solar';
const FUTURE_ALLOWANCE_MS = 300_000;
const SOURCE_WINDOWS = { thanda: 120, sales: 2160, 'victron-orders': 180, 'accepted-quotes': 120 };
const code = value => String(value || '').trim().toUpperCase();
const timestamp = value => {
  const time = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
};
export const inventoryQuantity = value => (typeof value === 'number' || (typeof value === 'string'
  && /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

// Full Items evidence is saved by the existing stock import. This module has
// no Hub/provider client, refresh, retry or schedule: zero additional API calls.
export async function ensureInventoryEvidenceSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS thanda_inventory_evidence (
    id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    company TEXT NOT NULL CHECK (company = 'thanda-solar'),
    observed_at TIMESTAMPTZ NOT NULL,
    snapshot TEXT NOT NULL,
    items JSONB NOT NULL,
    previously_tracked JSONB NOT NULL DEFAULT '{}'::jsonb,
    known_victron_codes JSONB NOT NULL DEFAULT '[]'::jsonb
  );
  ALTER TABLE thanda_inventory_evidence ADD COLUMN IF NOT EXISTS known_victron_codes JSONB NOT NULL DEFAULT '[]'::jsonb`);
}

function sanitizedItems(items) {
  if (!Array.isArray(items) || items.length > 50_000) throw new Error('Complete inventory Items evidence is required.');
  const codes = new Set();
  const ids = new Set();
  return items.map(item => {
    const itemCode = typeof item?.Code === 'string' ? code(item.Code) : '';
    const itemId = typeof item?.ItemID === 'string' ? item.ItemID.trim() : '';
    if (!itemCode || itemCode.length > 100 || !itemId || itemId.length > 100 || codes.has(itemCode) || ids.has(itemId)) {
      throw new Error('Inventory Items evidence has missing or duplicate code identities.');
    }
    codes.add(itemCode);
    ids.add(itemId);
    return { Code: itemCode, ItemID: itemId, Name: typeof item.Name === 'string' ? item.Name.slice(0, 1000) : '',
      IsTrackedAsInventory: item.IsTrackedAsInventory === true ? true : item.IsTrackedAsInventory === false ? false : null,
      QuantityOnHand: inventoryQuantity(item.QuantityOnHand) };
  });
}

/** Save only an already complete, validated Thanda Hub snapshot. */
export async function saveInventoryEvidence(db, items, { observedAt, snapshot, company = COMPANY } = {}, { now = Date.now() } = {}) {
  const observed = timestamp(observedAt);
  const nowMs = Number(new Date(now));
  if (company !== COMPANY || observed === null || !Number.isFinite(nowMs) || observed > nowMs + FUTURE_ALLOWANCE_MS
    || typeof snapshot !== 'string' || !snapshot.trim() || snapshot.length > 1000) {
    throw new Error('Inventory evidence has no reliable Thanda source identity or observation time.');
  }
  const clean = sanitizedItems(items);
  const seen = Object.fromEntries(clean.filter(item => item.IsTrackedAsInventory === true)
    .map(item => [item.Code, new Date(observed).toISOString()]));
  const owned = clean.filter(item => /\bVictron\b/i.test(item.Name) && item.IsTrackedAsInventory === true).map(item => item.Code);
  await ensureInventoryEvidenceSchema(db);
  // The row lock taken by ON CONFLICT serialises writers. Old imports cannot
  // erase current stock or the durable record that an article was tracked.
  const result = await db.query(`INSERT INTO thanda_inventory_evidence
    (id, company, observed_at, snapshot, items, previously_tracked, known_victron_codes)
    VALUES (true, $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)
    ON CONFLICT (id) DO UPDATE SET company=EXCLUDED.company,
      observed_at=EXCLUDED.observed_at, snapshot=EXCLUDED.snapshot, items=EXCLUDED.items,
      previously_tracked=thanda_inventory_evidence.previously_tracked || EXCLUDED.previously_tracked,
      known_victron_codes=(SELECT COALESCE(jsonb_agg(known_code ORDER BY known_code),'[]'::jsonb)
        FROM (SELECT DISTINCT known_code FROM jsonb_array_elements_text(
          thanda_inventory_evidence.known_victron_codes || EXCLUDED.known_victron_codes) known_code) owned)
    WHERE thanda_inventory_evidence.observed_at <= EXCLUDED.observed_at
    RETURNING observed_at`, [company, new Date(observed).toISOString(), snapshot, JSON.stringify(clean), JSON.stringify(seen), JSON.stringify(owned)]);
  if (result.rowCount === 0 || result.rows?.length === 0) throw new Error('An older inventory observation cannot replace current evidence.');
}

// One bounded set-oriented read. Sales presence includes credits and retained
// history, not net demand. Clearing a displayed backorder is not cancellation.
const REQUIREMENTS_SQL = `
  SELECT UPPER(sku) AS sku, 'Recorded sales or credit activity' AS signal, false AS is_victron,
    MAX(invoice_date)::timestamptz AS event_at
    FROM xero_sales_invoice_lines WHERE quantity <> 0 GROUP BY UPPER(sku)
  UNION ALL
  SELECT UPPER(line.sku), 'Open inbound delivery', true, NULL::timestamptz
    FROM supplier_inbound_order_lines line JOIN supplier_inbound_orders o ON o.id=line.inbound_order_id
    WHERE o.supplier='victron' AND o.status='open' AND line.is_stock_item=true
      AND line.ordered_quantity > line.received_quantity GROUP BY UPPER(line.sku)
  UNION ALL
  SELECT UPPER(sku), 'Supplier backorder', true, NULL::timestamptz
    FROM victron_provisional_backorder_order_lines WHERE quantity > 0 GROUP BY UPPER(sku)
  UNION ALL
  SELECT UPPER(sku), 'Provisional supplier cart', true, NULL::timestamptz
    FROM victron_provisional_cart_lines WHERE quantity > 0 GROUP BY UPPER(sku)
  UNION ALL
  SELECT UPPER(line.sku), 'Active accepted quote reservation', BOOL_OR(line.description ~* '\\mVictron\\M'), NULL::timestamptz
    FROM xero_accepted_quote_lines line JOIN xero_accepted_quotes q ON q.quote_id=line.quote_id
    WHERE q.reservation_eligible=true AND line.quantity > 0 GROUP BY UPPER(line.sku)
  UNION ALL
  SELECT UPPER(sku), 'Configured minimum stock', true, NULL::timestamptz
    FROM victron_stock_minima WHERE minimum_stock > 0 GROUP BY UPPER(sku)
  UNION ALL
  SELECT UPPER(proposal->>'code'), CASE WHEN e.action IN ('applied','batch-applied')
    THEN 'Confirmed Xero creation' ELSE 'Unresolved Xero creation' END, true, MAX(e.created_at)
    FROM victron_catalogue_events e CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(e.details->'request'->'payload'->'proposals')='array'
        THEN e.details->'request'->'payload'->'proposals'
        ELSE jsonb_build_array(e.details->'request'->'payload') END) proposal
    WHERE e.company='thanda-solar' AND e.action IN ('pending','unknown','applied','batch-pending','batch-unknown','batch-applied')
      AND proposal->>'action'='new' AND NULLIF(proposal->>'code','') IS NOT NULL
    GROUP BY UPPER(proposal->>'code'), CASE WHEN e.action IN ('applied','batch-applied')
      THEN 'Confirmed Xero creation' ELSE 'Unresolved Xero creation' END
  UNION ALL
  SELECT UPPER(sku), 'Confirmed Xero archive', true, MAX(created_at)
    FROM victron_catalogue_events WHERE company='thanda-solar' AND action='archive-reviewed'
      AND details->'stock'='0'::jsonb AND details->>'kind'='archive'
      AND details->>'eligibleForArchiveReview'='true' AND NULLIF(sku,'') IS NOT NULL
    GROUP BY UPPER(sku)`;

function sourceProblem(runs, now) {
  for (const [id, minutes] of Object.entries(SOURCE_WINDOWS)) {
    const run = runs.find(row => row.source_id === id || row.id === id);
    const observed = timestamp(run?.source_observed_at ?? run?.observedAt);
    const successful = timestamp(run?.last_successful_at ?? run?.lastSuccessAt);
    const status = run?.last_status ?? run?.lastRunStatus;
    if (!run || observed === null || successful === null || observed > now + FUTURE_ALLOWANCE_MS
      || successful > now + FUTURE_ALLOWANCE_MS || now - observed > minutes * 60_000
      || !['success', 'running'].includes(status) || run?.last_error || run?.lastError) {
      return `Inventory scope cannot be confirmed while ${id} source evidence is missing, overdue or incomplete.`;
    }
  }
  return null;
}

/**
 * Local evidence only. Catalogue absence is never presented as physical zero.
 * @param {any} db Local PostgreSQL query interface.
 * @param {{products?: Array<Record<string, any>>, successions?: Array<{predecessor_sku: string, successor_sku: string}>, runs?: Array<Record<string, any>>, now?: number | string | Date}} options
 * @returns {Promise<{articles: Map<string, {kind: 'required' | 'catalogue' | 'unknown', reasons: string[]}>, stockProducts: Array<{sku: string, supplier: 'victron', name: string, details: {xeroStockStatus: string, localStockOnHand: number | null, xeroStockSyncedAt: string | null, inventoryScope: 'required' | 'catalogue' | 'unknown', inventoryRequirementReasons: string[]}}>, catalogueOnly: Array<{sku: string, reason: string}>, complete: boolean, reason: string | null, observedAt: string | null}>}
 */
export async function loadInventoryScope(db, { products = [], successions = [], runs = [], now = Date.now() } = {}) {
  successions = victronArticleSuccessions(successions);
  const nowMs = Number(new Date(now));
  if (!Number.isFinite(nowMs)) throw new Error('A reliable inventory assessment time is required.');
  const results = await Promise.allSettled([
    db.query('SELECT company,observed_at,snapshot,items,previously_tracked,known_victron_codes FROM thanda_inventory_evidence WHERE id=true'),
    db.query(REQUIREMENTS_SQL),
  ]);
  let missingTable = false;
  for (const result of results) {
    if (result.status === 'rejected') {
      if (result.reason?.code !== '42P01') throw result.reason;
      missingTable = true;
    }
  }
  const evidence = results[0].status === 'fulfilled' ? results[0].value.rows[0] : null;
  const requirements = results[1].status === 'fulfilled' ? results[1].value.rows : [];
  const observed = timestamp(evidence?.observed_at);
  const usableIdentity = evidence?.company === COMPANY && typeof evidence.snapshot === 'string' && Boolean(evidence.snapshot.trim())
    && observed !== null && observed <= nowMs + FUTURE_ALLOWANCE_MS;
  let items = [];
  let reason = missingTable ? 'Inventory scope evidence has not been installed or imported completely.' : null;
  try { items = usableIdentity ? sanitizedItems(evidence.items) : []; }
  catch { reason ||= 'The saved inventory item list has invalid code identities.'; }
  if (!usableIdentity || nowMs - observed > SOURCE_WINDOWS.thanda * 60_000) {
    reason ||= 'The complete Thanda inventory snapshot is missing or overdue.';
  }
  const savedHistory = evidence?.previously_tracked;
  const validHistory = savedHistory !== null && typeof savedHistory === 'object' && !Array.isArray(savedHistory)
    && Object.entries(savedHistory).every(([sku, seenAt]) => code(sku) && timestamp(seenAt) !== null
      && timestamp(seenAt) <= nowMs + FUTURE_ALLOWANCE_MS);
  if (usableIdentity && !validHistory) reason ||= 'The saved previous inventory evidence is incomplete.';
  const knownVictron = evidence?.known_victron_codes;
  const validOwnership = Array.isArray(knownVictron) && knownVictron.every(sku => typeof sku === 'string' && code(sku));
  if (usableIdentity && !validOwnership) reason ||= 'The saved inventory supplier ownership evidence is incomplete.';
  reason ||= sourceProblem(runs, nowMs);
  const complete = reason === null;
  const observedAt = observed === null ? null : new Date(observed).toISOString();
  const productsByArticle = new Map();
  const itemsByArticle = new Map();
  const articles = new Map();
  const register = sku => {
    const article = stockSku(sku);
    if (article && !articles.has(article)) articles.set(article, { kind: 'unknown', reasons: [] });
    return article;
  };
  for (const product of products.filter(row => row.supplier === 'victron')) {
    const article = register(product.sku);
    const rows = productsByArticle.get(article) || [];
    rows.push(product);
    productsByArticle.set(article, rows);
  }
  for (const succession of successions) {
    register(succession.predecessor_sku);
    register(succession.successor_sku);
  }
  // A brand name on a service (for example an extended warranty) is not an
  // inventory requirement. Retain orphan ownership only with tracked history;
  // known catalogue articles and operational commitments are registered too.
  if (usableIdentity && validOwnership) for (const sku of knownVictron) {
    if (!validHistory || savedHistory[sku]) register(sku);
  }
  for (const item of items) {
    const article = stockSku(item.Code);
    if (/\bVictron\b/i.test(item.Name) && (item.IsTrackedAsInventory === true || item.QuantityOnHand > 0)) register(article);
    const rows = itemsByArticle.get(article) || [];
    rows.push(item);
    itemsByArticle.set(article, rows);
  }
  const seen = usableIdentity && validHistory ? savedHistory : {};
  const factsByArticle = new Map();
  const seenAtByArticle = new Map();
  for (const [sku, seenAt] of Object.entries(seen)) {
    const time = timestamp(seenAt);
    if (time !== null && time <= nowMs + FUTURE_ALLOWANCE_MS) {
      const article = stockSku(sku);
      seenAtByArticle.set(article, Math.max(time, seenAtByArticle.get(article) ?? 0));
    }
  }
  const addFact = (article, message, { historical = false, at = null } = {}) => {
    if (!articles.has(article)) return;
    const facts = factsByArticle.get(article) || [];
    facts.push({ message, historical, at });
    factsByArticle.set(article, facts);
  };
  for (const [article, rows] of productsByArticle) {
    for (const product of rows) {
      const details = product.details || {};
      const seenAt = timestamp(details.xeroInventorySeenAt) ?? seenAtByArticle.get(article) ?? null;
      if (details.xeroStockStatus === 'tracked') addFact(article, 'Previously imported tracked Xero item', {
        historical: true, at: seenAt ?? timestamp(details.xeroStockSyncedAt),
      });
      if (details.xeroInventorySeen || details.xeroInventorySeenAt || details.xeroItemId || details.xeroCreatedItemId) {
        addFact(article, 'Previously seen or created in Xero', { historical: true, at: seenAt ?? timestamp(details.xeroCreatedAt) });
      }
      if ((inventoryQuantity(details.localStockOnHand) ?? 0) > 0) addFact(article, 'Retained positive Thanda stock');
    }
  }
  for (const [article, at] of seenAtByArticle) {
    addFact(article, 'Previously tracked in Xero', { historical: true, at });
  }
  const archiveAtByArticle = new Map();
  for (const requirement of requirements) {
    if (requirement.is_victron === true) register(requirement.sku);
    const article = stockSku(requirement.sku);
    const at = timestamp(requirement.event_at);
    if (requirement.signal === 'Confirmed Xero archive') {
      if (at !== null && at <= nowMs + FUTURE_ALLOWANCE_MS) archiveAtByArticle.set(article, Math.max(at, archiveAtByArticle.get(article) ?? 0));
      continue;
    }
    addFact(article, String(requirement.signal), {
      historical: ['Recorded sales or credit activity', 'Confirmed Xero creation'].includes(requirement.signal), at,
    });
  }
  const stockProducts = [];
  const catalogueOnly = [];
  for (const [article, scope] of articles) {
    const usableStock = item => item.IsTrackedAsInventory === true && item.QuantityOnHand !== null && item.QuantityOnHand >= 0;
    const candidates = [...(itemsByArticle.get(article) || [])].sort((a, b) =>
      Number(usableStock(b)) - Number(usableStock(a))
      || Number(b.IsTrackedAsInventory === true) - Number(a.IsTrackedAsInventory === true)
      || Number(a.Code.endsWith('R')) - Number(b.Code.endsWith('R')) || a.Code.localeCompare(b.Code));
    if (candidates.length) addFact(article, candidates.some(item => item.IsTrackedAsInventory === true)
      ? 'Present as tracked inventory in the saved Xero list' : 'Present in the saved Xero list');
    const facts = factsByArticle.get(article) || [];
    scope.reasons = [...new Set(facts.map(fact => fact.message))];
    scope.kind = facts.length ? 'required' : complete ? 'catalogue' : 'unknown';
    const archivedAt = archiveAtByArticle.get(article);
    // A reviewed archive can release past-only activity after a complete
    // post-archive absence observation. Retirement, hidden rows and 90-day
    // ignores cannot release stock or a live commitment. Undated past evidence
    // remains unresolved instead of claiming either no stock or perpetual demand.
    if (archivedAt !== undefined && facts.every(fact => fact.historical) && complete) {
      if (observed < archivedAt) {
        scope.kind = 'unknown';
        scope.reasons.push('Archive confirmation is newer than the saved Xero list; await a complete stock import.');
      } else if (facts.some(fact => fact.at === null)) {
        scope.kind = 'unknown';
        scope.reasons.push('Archive completion is recorded, but earlier inventory activity has no reliable date.');
      } else if (facts.every(fact => fact.at <= archivedAt)) {
        scope.kind = 'catalogue';
        scope.reasons = ['Confirmed archived in Xero; absent from the complete later item list with no live stocking requirement.'];
      }
    }
    if (scope.kind === 'catalogue') {
      if (!scope.reasons.length) scope.reasons.push('Not in the complete saved Thanda Xero list and no recorded stocking requirement.');
      catalogueOnly.push({ sku: article, reason: scope.reasons[0] });
      continue;
    }
    if (scope.kind === 'unknown' && reason) scope.reasons.push(reason);
    const item = candidates[0];
    const product = productsByArticle.get(article)?.[0];
    stockProducts.push({ sku: article, supplier: 'victron', name: product?.name || item?.Name || article,
      details: {
        xeroStockStatus: !item ? 'missing' : item.IsTrackedAsInventory === true ? 'tracked' : item.IsTrackedAsInventory === false ? 'untracked' : 'unknown',
        localStockOnHand: item?.IsTrackedAsInventory === true ? inventoryQuantity(item.QuantityOnHand) : null,
        xeroStockSyncedAt: observedAt,
        inventoryScope: scope.kind,
        inventoryRequirementReasons: scope.reasons,
      } });
  }
  stockProducts.sort((a, b) => a.sku.localeCompare(b.sku));
  catalogueOnly.sort((a, b) => a.sku.localeCompare(b.sku));
  return { articles, stockProducts, catalogueOnly, complete, reason, observedAt };
}
