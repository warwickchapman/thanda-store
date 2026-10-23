import test from 'node:test';
import assert from 'node:assert/strict';
import { awaitingCatalogueStockImports, confirmedCatalogueRemoval, stockHealthIssues, sourceRecovery, supplierLifecycleActions, supplierStockScope } from '../src/lib/data-health-actions.mjs';
import { DATA_SOURCES } from '../src/lib/data-freshness.mjs';

const now = new Date('2026-09-28T12:00:00Z');
const source = id => DATA_SOURCES.find(row => row.id === id);
test('diagnostics distinguish missing Xero items, untracked items and confirmed zero', () => {
  const issues = stockHealthIssues(source('thanda'), [
    { sku: 'A', supplier: 'victron', details: { xeroStockStatus: 'missing' } },
    { sku: 'B', supplier: 'victron', details: { xeroStockStatus: 'untracked' } },
    { sku: 'C', supplier: 'victron', details: { xeroStockStatus: 'tracked', xeroStockSyncedAt: now.toISOString(), localStockOnHand: 0 } },
    { sku: 'D', supplier: 'renogy', details: {} },
  ], now);
  assert.deepEqual(issues.map(row => row.sku), ['A', 'B']);
  assert.match(issues[0].reason, /Required inventory article is missing/);
  assert.match(issues[0].remedy, /catalogue review for a product addition if required/);
  assert.match(issues[1].remedy, /bookkeeper/);
});
test('catalogue omissions are informational; unknown and required inventory remain diagnostic regardless of ZA stock or retired decisions', () => {
  const issues = stockHealthIssues(source('thanda'), [
    { sku: 'PIN121250500', supplier: 'victron', details: { xeroStockStatus: 'missing', inventoryScope: 'catalogue' }, stock_on_hand: 0 },
    { sku: 'SPM040303604', supplier: 'victron', details: { xeroStockStatus: 'missing', inventoryScope: 'unknown' }, stock_on_hand: 0 },
    { sku: 'RETIRED', supplier: 'victron', details: { xeroStockStatus: 'missing', inventoryScope: 'required' }, stockReview: { decision: 'retired' }, stock_on_hand: 0 },
    { sku: 'LRS1', supplier: 'lora', details: { xeroStockStatus: 'missing' } },
  ], now);
  assert.equal(issues.length, 3);
  for (const issue of issues.filter(issue => issue.sku !== 'LRS1')) {
    assert.match(issue.remedy, /does not confirm zero Thanda stock/);
  }
  assert.ok(!issues.some(issue => issue.sku === 'PIN121250500'));
  assert.match(issues.find(issue => issue.sku === 'SPM040303604').reason, /Cannot confirm/);
  assert.equal(issues.find(issue => issue.sku === 'LRS1').reviewUrl, undefined);
});
test('supplier diagnostics separate missing observations and stale retained quantities', () => {
  const issues = stockHealthIssues(source('victron'), [
    { sku: 'A', supplier: 'victron', stock_on_hand: 4, details: {} },
    { sku: 'B', supplier: 'victron', stock_on_hand: 0, details: { supplierObservedAt: '2026-09-27T00:00:00Z' } },
    { sku: 'C', supplier: 'victron', stock_on_hand: 0, details: { supplierObservedAt: now.toISOString() } },
  ], now);
  assert.deepEqual(issues.map(row => row.sku), ['A', 'B']);
  assert.match(issues[0].reason, /No confirmed/);
  assert.match(issues[1].reason, /overdue/);
});
test('confirmed supplier removals are lifecycle information; unknown membership stays a stock diagnostic', () => {
  for (const supplier of ['victron', 'renogy']) {
    const removed = { supplier, sku: 'REMOVED001', name: 'Retained product', stock_on_hand: 7,
      details: { cataloguePresent: false, catalogueObservedAt: now.toISOString(), supplierObservedAt: '2026-09-01T12:00:00Z' } };
    const before = structuredClone(removed);
    const unknown = { supplier, sku: 'UNKNOWN001', details: {} };
    const result = supplierStockScope(supplier, [removed, unknown], now);
    assert.deepEqual(result.activeProducts, [unknown]);
    assert.deepEqual(result.lifecycleItems, [{ sku: removed.sku, name: removed.name, observedAt: now.toISOString() }]);
    assert.deepEqual(stockHealthIssues(source(supplier), [removed, unknown], now).map(row => row.sku), ['UNKNOWN001']);
    assert.deepEqual(removed, before, 'catalogue absence never replaces a retained quantity or its observation');
    for (const details of [
      { cataloguePresent: false }, { cataloguePresent: false, catalogueObservedAt: 'not a time' },
      { cataloguePresent: false, catalogueObservedAt: '2026-09-29T12:00:00Z' },
      { cataloguePresent: true, catalogueObservedAt: now.toISOString() },
      { cataloguePresent: 'false', catalogueObservedAt: now.toISOString() },
    ]) assert.equal(confirmedCatalogueRemoval({ ...removed, details }, now), false);
  }
});
test('only recent confirmed Thanda creation newer than complete saved inventory waits for stock import', () => {
  const product = { supplier: 'victron', sku: 'PMP482305012', name: 'MultiPlus', details: {
    xeroStockStatus: 'missing', inventoryScope: 'required', inventoryRequirementReasons: ['Confirmed Xero creation'],
  } };
  const creation = { company: 'thanda-solar', sku: 'PMP482305012R', created_at: '2026-09-28T11:00:00Z', confirmed_at: '2026-09-28T11:55:00Z' };
  const options = { observedAt: '2026-09-28T11:30:00Z', complete: true, now };
  assert.deepEqual(awaitingCatalogueStockImports([product], [creation], options), [{ sku: product.sku, name: product.name, createdAt: '2026-09-28T11:55:00.000Z' }]);
  for (const overrides of [
    { complete: false }, { observedAt: null }, { observedAt: '2026-09-28T11:56:00Z' },
    { now: '2026-09-28T14:00:01Z' },
  ]) assert.deepEqual(awaitingCatalogueStockImports([product], [creation], { ...options, ...overrides }), []);
  for (const overrides of [
    { company: 'sensible-solar' }, { confirmed_at: '2026-09-29T12:00:00Z' },
    { confirmed_at: null },
  ]) assert.deepEqual(awaitingCatalogueStockImports([product], [{ ...creation, ...overrides }], options), []);
  for (const details of [
    { xeroStockStatus: 'tracked', localStockOnHand: 0 }, { localStockOnHand: 2 },
    { inventoryRequirementReasons: ['Retained positive Thanda stock'] },
    { inventoryRequirementReasons: ['Active accepted quote reservation'] },
  ]) assert.deepEqual(awaitingCatalogueStockImports([{ ...product, details: { ...product.details, ...details } }], [creation], options), []);
  assert.equal(product.details.xeroStockStatus, 'missing', 'waiting does not invent a stock observation');
});
test('supplier removal information counts only existing Thanda archive decisions as work', () => {
  const lifecycleItems = Array.from({ length: 11 }, (_, index) => ({ sku: `REMOVED${index}` }));
  const rows = lifecycleItems.slice(0, 5).map(item => ({ ...item, company: 'thanda-solar', kind: 'archive' }));
  const history = Object.fromEntries(rows.map(row => [row.sku, { absentSince: '2026-09-27' }]));
  const review = { checked_at: now.toISOString(), observed_at: now.toISOString(), rows: [
    ...rows, { sku: 'REMOVED6', company: 'sensible-solar', kind: 'archive' },
    { sku: 'NOT-REMOVED', company: 'thanda-solar', kind: 'archive' },
    { sku: 'REMOVED7', company: 'thanda-solar', kind: 'price' },
  ], history };
  assert.equal(supplierLifecycleActions('victron', lifecycleItems, review, [], now).lifecycleActionCount, 5);
  const completed = [{ company: 'thanda-solar', sku: 'REMOVED0', completed_at: '2026-09-28T10:00:00Z' }];
  assert.equal(supplierLifecycleActions('victron', lifecycleItems, review, completed, now).lifecycleActionCount, 4);
  assert.equal(supplierLifecycleActions('victron', lifecycleItems, review,
    rows.map(row => ({ company: row.company, sku: row.sku, completed_at: '2026-09-28T10:00:00Z' })), now).lifecycleActionCount, 0);
  for (const event of [
    { company: 'sensible-solar', sku: 'REMOVED0', completed_at: '2026-09-28T10:00:00Z' },
    { company: 'thanda-solar', sku: 'REMOVED0', completed_at: '2026-09-26T10:00:00Z' },
  ]) assert.equal(supplierLifecycleActions('victron', lifecycleItems, review, [event], now).lifecycleActionCount, 5,
    'another company or earlier retirement episode cannot complete a current archive');
  assert.equal(supplierLifecycleActions('renogy', lifecycleItems, undefined, [], now).lifecycleActionCount, 0,
    'known supplier absence is not a second Renogy work queue');
});
test('unavailable or stale archive comparison cannot invent cleanup counts or ask to repeat recorded archives', () => {
  const lifecycleItems = [{ sku: 'REMOVED0' }];
  const review = { checked_at: now.toISOString(), observed_at: now.toISOString(),
    rows: [{ sku: 'REMOVED0', company: 'thanda-solar', kind: 'archive' }], history: { REMOVED0: { absentSince: '2026-09-27' } } };
  const completed = [{ company: 'thanda-solar', sku: 'REMOVED0', completed_at: now.toISOString() }];
  for (const state of [undefined, { ...review, checked_at: '2026-09-26T12:00:00Z' },
    { ...review, error: 'The comparison could not be refreshed' }, { ...review, history: null },
    { ...review, observed_at: '2026-09-29T12:00:00Z' }]) {
    const result = supplierLifecycleActions('victron', lifecycleItems, state, completed, now);
    assert.equal(result.lifecycleActionCount, null);
    assert.match(result.lifecycleReviewMessage, /Compare saved records/);
    assert.match(result.lifecycleReviewMessage, /do not repeat/);
  }
});
test('rate limits and authentication have different recovery instructions without leaking errors', () => {
  const rateLimit = sourceRecovery({ ...source('victron'), status: 'error', lastError: 'Source request failed (HTTP 429). token=secret' });
  assert.match(rateLimit[0], /cooldown/);
  assert.match(rateLimit[0], /do not repeatedly refresh/);
  assert.ok(!rateLimit.join('').includes('secret'));
  const auth = sourceRecovery({ ...source('thanda'), status: 'error', lastError: 'HTTP 401' });
  assert.match(auth[0], /shared Xero Hub/);
});
