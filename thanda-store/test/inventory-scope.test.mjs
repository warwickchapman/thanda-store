import assert from 'node:assert/strict';
import test from 'node:test';
import { loadInventoryScope, saveInventoryEvidence } from '../src/lib/inventory-scope.mjs';

const now = Date.parse('2026-10-14T10:00:00.000Z');
const observedAt = '2026-10-14T09:30:00.000Z';
const sourceIds = ['thanda', 'sales', 'victron-orders', 'accepted-quotes'];
const successfulRuns = () => sourceIds.map(source_id => ({ source_id, last_status: 'success',
  source_observed_at: observedAt, last_successful_at: observedAt }));
const product = (sku, details = {}) => ({ supplier: 'victron', sku, name: sku, details });
const item = (Code, QuantityOnHand = 0, extra = {}) => ({ Code, ItemID: `id-${Code}`, Name: Code,
  IsTrackedAsInventory: true, QuantityOnHand, ...extra });
const successions = [{ predecessor_sku: 'PMP482305010', successor_sku: 'PMP482305012' }];

async function scope(options = {}) {
  const { items = [], requirements = [], previouslyTracked = {}, knownVictron = [], evidenceOverrides = {},
    products = [product('PMP482305010'), product('PMP482305012')], runs = successfulRuns(),
    missingTable = false, dbError = null, ...rest } = options;
  const queries = [];
  const db = { query: async sql => {
    queries.push(sql);
    if (dbError) throw dbError;
    if (missingTable && sql.includes('xero_sales_invoice_lines')) throw Object.assign(new Error('not installed'), { code: '42P01' });
    return sql.includes('thanda_inventory_evidence') ? { rows: [{ company: 'thanda-solar', observed_at: observedAt,
      snapshot: 'snapshot-1', items, previously_tracked: previouslyTracked, known_victron_codes: knownVictron, ...evidenceOverrides }] } : { rows: requirements };
  } };
  return { ...(await loadInventoryScope(db, { products, runs, successions, now, ...rest })), queries };
}

test('complete absence is catalogue-only, never a fabricated zero quantity', async () => {
  const result = await scope();
  assert.equal(result.complete, true);
  assert.equal(result.articles.get('PMP482305010').kind, 'catalogue');
  assert.equal(result.articles.get('PMP482305012').kind, 'catalogue');
  assert.deepEqual(result.stockProducts, []);
  assert.equal(result.catalogueOnly.length, 2);
  assert.equal(result.queries.length, 2);
});

test('current tracked zero is required and keeps zero as an actual observation', async () => {
  const result = await scope({ items: [item('PMP482305012')] });
  assert.equal(result.articles.get('PMP482305012').kind, 'required');
  assert.deepEqual(result.stockProducts[0].details, {
    xeroStockStatus: 'tracked', localStockOnHand: 0, xeroStockSyncedAt: observedAt,
    inventoryScope: 'required', inventoryRequirementReasons: ['Present as tracked inventory in the saved Xero list'],
  });
  assert.equal(result.articles.get('PMP482305010').kind, 'catalogue');
});

test('untracked items stay required for review and never produce a stock balance', async () => {
  const result = await scope({ items: [item('PMP482305012', 7, { IsTrackedAsInventory: false })] });
  assert.equal(result.articles.get('PMP482305012').kind, 'required');
  assert.equal(result.stockProducts[0].details.xeroStockStatus, 'untracked');
  assert.equal(result.stockProducts[0].details.localStockOnHand, null);
});

test('hidden predecessor stock contributes but does not require an unstocked successor', async () => {
  const result = await scope({ products: [product('PMP482305010', { hidden: true })], items: [item('PMP482305010', 5)] });
  assert.equal(result.articles.get('PMP482305010').kind, 'required');
  assert.equal(result.stockProducts[0].details.localStockOnHand, 5);
  assert.equal(result.articles.get('PMP482305012').kind, 'catalogue');
});

test('a previously tracked disappeared article remains required with unknown stock', async () => {
  const result = await scope({ previouslyTracked: { PMP482305010: '2026-10-10T09:00:00Z' } });
  assert.equal(result.articles.get('PMP482305010').kind, 'required');
  assert.equal(result.stockProducts[0].details.xeroStockStatus, 'missing');
  assert.equal(result.stockProducts[0].details.localStockOnHand, null);
  assert.equal(result.articles.get('PMP482305012').kind, 'catalogue');
});

test('legacy seen, tracked, created, and positive local evidence all preserve review', async () => {
  for (const details of [
    { xeroStockStatus: 'tracked' }, { xeroInventorySeen: true }, { xeroItemId: 'previous-id' },
    { xeroCreatedItemId: 'created-id' }, { localStockOnHand: 2 },
  ]) {
    const result = await scope({ products: [product('PMP482305010', details)] });
    assert.equal(result.articles.get('PMP482305010').kind, 'required', JSON.stringify(details));
    assert.equal(result.stockProducts[0].details.localStockOnHand, null);
  }
});

test('credits and retained sales activity require only their literal article', async () => {
  const result = await scope({ requirements: [{ sku: 'PMP482305010', signal: 'Recorded sales or credit activity' }] });
  assert.equal(result.articles.get('PMP482305010').kind, 'required');
  assert.equal(result.articles.get('PMP482305012').kind, 'catalogue');
  assert.match(result.queries[1], /quantity <> 0/);
});

test('each direct Victron obligation registers even an article absent from the Store', async () => {
  for (const signal of ['Open inbound delivery', 'Supplier backorder', 'Provisional supplier cart',
    'Active accepted quote reservation', 'Configured minimum stock', 'Confirmed Xero creation', 'Unresolved Xero creation']) {
    const result = await scope({ requirements: [{ sku: 'DIRECT001R', signal, is_victron: true }], products: [] });
    assert.equal(result.articles.get('DIRECT001').kind, 'required', signal);
    assert.equal(result.stockProducts[0].sku, 'DIRECT001');
    assert.equal(result.stockProducts[0].details.localStockOnHand, null);
  }
});

test('Cleared supplier backorders and catalogue ignores cannot erase a commitment', async () => {
  const result = await scope({ products: [product('PMP482305010', { purchasingRetiredReason: 'obsolete', hidden: true,
    stockReview: { decision: 'do_not_stock' }, ignoredUntil: '2027-01-01' })], requirements: [
    { sku: 'PMP482305010', signal: 'Supplier backorder', is_victron: true },
  ] });
  assert.equal(result.articles.get('PMP482305010').kind, 'required');
  assert.equal(result.queries[1].includes('victron_backorder_ignored_lines'), false);
});

test('base and retail are one article, with base preferred and usable retail fallback', async () => {
  for (const [base, expected] of [[0, 0], [null, 6], ['invalid', 6]]) {
    const result = await scope({ products: [product('ALIAS001'), product('ALIAS001R')],
      successions: [], items: [item('ALIAS001', base), item('ALIAS001R', 6)] });
    assert.equal(result.stockProducts.length, 1);
    assert.equal(result.stockProducts[0].sku, 'ALIAS001');
    assert.equal(result.stockProducts[0].details.localStockOnHand, expected);
  }
});

test('explicit Victron items outside the Store remain in inventory health', async () => {
  const result = await scope({ products: [], successions: [], items: [
    item('ORPHAN001', 3, { Name: 'Victron old stocked item' }), item('OTHER001', 7, { Name: 'Other supplier item' }),
  ] });
  assert.equal(result.articles.get('ORPHAN001').kind, 'required');
  assert.equal(result.articles.has('OTHER001'), false);
});

test('a positively identified Victron orphan remains required after it disappears', async () => {
  const first = await scope({ products: [], successions: [], items: [item('ORPHAN001', 3, { Name: 'Victron old stock' })] });
  assert.equal(first.articles.get('ORPHAN001').kind, 'required');
  const later = await scope({ products: [], successions: [], knownVictron: ['ORPHAN001'],
    previouslyTracked: { ORPHAN001: '2026-10-10T09:00:00Z' }, items: [] });
  assert.equal(later.articles.get('ORPHAN001').kind, 'required');
  assert.equal(later.stockProducts[0].details.localStockOnHand, null);
  assert.equal(later.stockProducts[0].details.xeroStockStatus, 'missing');
});

test('malformed quantities remain unknown rather than coercing containers or booleans to zero', async () => {
  for (const value of [[], {}, false, true, '', '  ', '0x0', '1e3', 'NaN']) {
    const result = await scope({ items: [item('PMP482305010', value)] });
    assert.equal(result.stockProducts[0].details.localStockOnHand, null, JSON.stringify(value));
    assert.equal(result.articles.get('PMP482305010').kind, 'required');
  }
  const decimal = await scope({ items: [item('PMP482305010', '0.000')] });
  assert.equal(decimal.stockProducts[0].details.localStockOnHand, 0);
});

test('stale, failed, partial, absent and future source metadata cannot prove catalogue-only', async () => {
  for (const source_id of sourceIds) {
    for (const patch of [{ last_status: 'failed' }, { last_status: 'partial' }, { source_observed_at: null },
      { source_observed_at: '2026-10-01T09:00:00Z' }, { source_observed_at: '2026-10-15T09:00:00Z' }]) {
      const runs = successfulRuns().map(run => run.source_id === source_id ? { ...run, ...patch } : run);
      const result = await scope({ runs });
      assert.equal(result.complete, false, `${source_id} ${JSON.stringify(patch)}`);
      assert.equal(result.articles.get('PMP482305010').kind, 'unknown');
      assert.equal(result.stockProducts[0].details.localStockOnHand, null);
      assert.match(result.reason, new RegExp(source_id));
    }
  }
});

test('missing cached evidence or exposure tables keeps scope unknown; other DB errors propagate', async () => {
  const absent = await scope({ missingTable: true });
  assert.equal(absent.complete, false);
  assert.equal(absent.articles.get('PMP482305010').kind, 'unknown');
  assert.equal(absent.queries.length, 2);
  await assert.rejects(scope({ dbError: Object.assign(new Error('connection lost'), { code: '08006' }) }), /connection lost/);
});

test('wrong-company, malformed and stale snapshots cannot supply a Thanda zero', async () => {
  const wrong = await scope({ items: [item('PMP482305010', 6)], evidenceOverrides: { company: 'sensible-solar' } });
  assert.equal(wrong.complete, false);
  assert.equal(wrong.articles.get('PMP482305010').kind, 'unknown');
  assert.equal(wrong.stockProducts[0].details.localStockOnHand, null);
  const malformed = await scope({ items: [item('PMP482305010'), item('PMP482305010')] });
  assert.equal(malformed.complete, false);
  assert.equal(malformed.stockProducts[0].details.localStockOnHand, null);
  for (const snapshot of ['', ' ', 1, null]) {
    const invalidRevision = await scope({ evidenceOverrides: { snapshot } });
    assert.equal(invalidRevision.complete, false);
    assert.equal(invalidRevision.articles.get('PMP482305010').kind, 'unknown');
  }
  for (const history of [null, [], { PMP482305010: 'not a date' }]) {
    const invalidHistory = await scope({ evidenceOverrides: { previously_tracked: history } });
    assert.equal(invalidHistory.complete, false);
    assert.equal(invalidHistory.articles.get('PMP482305010').kind, 'unknown');
  }
  const stale = await scope({ items: [item('PMP482305010', 6)], evidenceOverrides: { observed_at: '2026-10-14T05:00:00Z' } });
  assert.equal(stale.complete, false);
  assert.equal(stale.articles.get('PMP482305010').kind, 'required');
  assert.equal(stale.articles.get('PMP482305012').kind, 'unknown');
  assert.equal(stale.stockProducts[0].details.xeroStockSyncedAt, '2026-10-14T05:00:00.000Z');
});

test('confirmed archive releases dated past-only stock after a later complete absence', async () => {
  const result = await scope({ previouslyTracked: { PMP482305010: '2026-10-10T09:00:00Z' }, requirements: [
    { sku: 'PMP482305010', signal: 'Recorded sales or credit activity', event_at: '2026-10-09T00:00:00Z' },
    { sku: 'PMP482305010', signal: 'Confirmed Xero archive', is_victron: true, event_at: '2026-10-12T09:00:00Z' },
  ] });
  assert.equal(result.articles.get('PMP482305010').kind, 'catalogue');
  assert.match(result.catalogueOnly.find(row => row.sku === 'PMP482305010').reason, /Confirmed archived/);
  assert.deepEqual(result.stockProducts, []);
});

test('archive cannot release current items, stock, commitments or unresolved creation', async () => {
  const archive = { sku: 'PMP482305010', signal: 'Confirmed Xero archive', is_victron: true, event_at: '2026-10-12T09:00:00Z' };
  for (const signal of ['Open inbound delivery', 'Supplier backorder', 'Provisional supplier cart',
    'Active accepted quote reservation', 'Configured minimum stock', 'Unresolved Xero creation']) {
    const result = await scope({ requirements: [archive, { sku: 'PMP482305010', signal }] });
    assert.equal(result.articles.get('PMP482305010').kind, 'required', signal);
  }
  assert.equal((await scope({ requirements: [archive], items: [item('PMP482305010', 0)] })).articles.get('PMP482305010').kind, 'required');
  assert.equal((await scope({ requirements: [archive], products: [product('PMP482305010', { localStockOnHand: 2 })] })).articles.get('PMP482305010').kind, 'required');
});

test('archive before new activity, after the snapshot, or with undated history stays unresolved', async () => {
  const archive = { sku: 'PMP482305010', signal: 'Confirmed Xero archive', is_victron: true, event_at: '2026-10-14T09:45:00Z' };
  const waiting = await scope({ requirements: [archive] });
  assert.equal(waiting.articles.get('PMP482305010').kind, 'unknown');
  assert.match(waiting.articles.get('PMP482305010').reasons.join(' '), /newer than the saved Xero list/);
  const undated = await scope({ requirements: [{ ...archive, event_at: '2026-10-12T09:00:00Z' }],
    products: [product('PMP482305010', { xeroInventorySeen: true })] });
  assert.equal(undated.articles.get('PMP482305010').kind, 'unknown');
  assert.match(undated.articles.get('PMP482305010').reasons.join(' '), /no reliable date/);
  const newer = await scope({ previouslyTracked: { PMP482305010: observedAt },
    requirements: [{ ...archive, event_at: '2026-10-12T09:00:00Z' }] });
  assert.equal(newer.articles.get('PMP482305010').kind, 'required');
});

test('writer sanitizes full evidence, retains monotonic tracked history and rejects older imports', async () => {
  const calls = [];
  const db = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rowCount: 1, rows: [{ observed_at: observedAt }] };
  } };
  await saveInventoryEvidence(db, [item(' pmp482305010 ', 5, { Name: 'Victron inverter', Secret: 'not stored', Description: 'not stored' })],
    { observedAt, snapshot: 'revision1', company: 'thanda-solar' }, { now });
  const insert = calls[1];
  const stored = JSON.parse(insert.values[3]);
  assert.equal(stored[0].Code, 'PMP482305010');
  assert.deepEqual(Object.keys(stored[0]), ['Code', 'ItemID', 'Name', 'IsTrackedAsInventory', 'QuantityOnHand']);
  assert.deepEqual(JSON.parse(insert.values[4]), { PMP482305010: observedAt });
  assert.deepEqual(JSON.parse(insert.values[5]), ['PMP482305010']);
  assert.match(insert.sql, /previously_tracked=thanda_inventory_evidence\.previously_tracked \|\| EXCLUDED\.previously_tracked/);
  assert.match(insert.sql, /observed_at <= EXCLUDED\.observed_at/);
  assert.match(insert.sql, /thanda_inventory_evidence\.known_victron_codes \|\| EXCLUDED\.known_victron_codes/);
  await assert.rejects(saveInventoryEvidence({ query: async sql => sql.startsWith('CREATE') ? {} : { rowCount: 0, rows: [] } },
    [], { observedAt, snapshot: 'older' }, { now }), /older inventory observation/);
});

test('invalid writer evidence fails before touching the database', async () => {
  let calls = 0;
  const db = { query: async () => { calls++; } };
  for (const [items, meta] of [
    [[], { observedAt, snapshot: 's', company: 'sensible-solar' }], [[], { observedAt: null, snapshot: 's' }],
    [[], { observedAt: '2026-10-15T00:00:00Z', snapshot: 's' }], [[], { observedAt, snapshot: '' }],
    [[item('A'), item('a')], { observedAt, snapshot: 's' }],
    [[item('A'), item('B', 0, { ItemID: 'id-A' })], { observedAt, snapshot: 's' }],
    [[{ Code: 'A' }], { observedAt, snapshot: 's' }],
  ]) await assert.rejects(saveInventoryEvidence(db, items, meta, { now }));
  assert.equal(calls, 0);
});
