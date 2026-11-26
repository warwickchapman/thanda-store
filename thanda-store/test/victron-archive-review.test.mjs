import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveReadiness, archiveReadyRows } from '../src/lib/victron-archive-review.mjs';
import { reviewCatalogue, advanceHistory } from '../src/lib/victron-catalogue-review.mjs';

const predecessor = 'PMP482305010';
const successor = 'PMP482305012';
const successions = [{ predecessor_sku: predecessor, successor_sku: successor }];
const row = (overrides = {}) => ({ company: 'thanda-solar', sku: predecessor, name: 'Victron predecessor',
  kind: 'archive', eligibleForArchiveReview: true, stock: 0, stockTracked: true, itemId: 'exact-xero-item',
  replaces: [], replacedBy: [successor], ...overrides });

test('archive readiness requires confirmed retirement, tracked literal zero and exact Xero identity', () => {
  assert.deepEqual(archiveReadiness(row()), { status: 'ready', label: 'Ready to archive in Xero', blocker: null, ready: true });
  for (const change of [
    { kind: 'price' }, { kind: 'new' }, { kind: 'review' },
    { eligibleForArchiveReview: false }, { eligibleForArchiveReview: undefined },
    { stockTracked: false }, { stockTracked: null }, { stockTracked: undefined },
    { itemId: '' }, { itemId: '  ' }, { itemId: null }, { itemId: 123 },
    { stock: null }, { stock: undefined }, { stock: '0' }, { stock: false }, { stock: NaN }, { stock: Infinity },
  ]) {
    const result = archiveReadiness(row(change));
    assert.equal(result.ready, false, JSON.stringify(change));
    assert.ok(result.blocker);
  }
  assert.match(archiveReadiness(row({ stockTracked: false })).blocker, /not tracked/);
  assert.match(archiveReadiness(row({ stockTracked: undefined })).blocker, /tracking is unknown/);
});

test('positive, fractional and negative stock remain visible with distinct blockers', () => {
  for (const stock of [1, 0.5, 12, -1, -0.5]) {
    const result = archiveReadiness(row({ stock }));
    assert.equal(result.ready, false);
    assert.equal(result.status, 'stock');
    assert.match(result.blocker, new RegExp(String(stock).replace('.', '\\.')));
    assert.equal(result.label, stock > 0 ? 'Stock remains' : 'Stock needs checking');
  }
});

test('overdue and failed comparisons cannot yield a ready archive list', () => {
  for (const context of [{ overdue: true }, { error: 'The saved Xero snapshot is incomplete.' }, { overdue: true, error: 'Failure' }]) {
    assert.equal(archiveReadiness(row(), context).status, 'stale');
    assert.equal(archiveReadiness(row(), context).ready, false);
    assert.deepEqual(archiveReadyRows([row()], context), []);
  }
});

test('the report preserves each exact SKU, company and directed replacement without family totals', () => {
  const thandaOld = row();
  const sensibleOld = row({ company: 'sensible-solar', itemId: 'sensible-item', stock: 2 });
  const current = row({ sku: successor, itemId: 'current-item', kind: 'price', stock: 8, eligibleForArchiveReview: false, replacedBy: [] });
  const retail = row({ sku: `${predecessor}R`, itemId: 'retail-item', stock: 3 });
  const thandaAbsent = row({ sku: 'RETIRED-OTHER', itemId: 'other-item', replacedBy: [] });
  const rows = [thandaOld, sensibleOld, current, retail, thandaAbsent];
  const before = structuredClone(rows);
  const ready = archiveReadyRows(rows);
  assert.deepEqual(ready, [thandaOld, thandaAbsent]);
  assert.equal(ready[0], thandaOld, 'the report retains exact Xero identity and replacement context');
  assert.deepEqual(ready[0].replacedBy, [successor]);
  assert.deepEqual(rows, before, 'assessment never hides or rewrites positive/unknown stock rows');
});

const now = Date.parse('2026-11-26T08:00:00Z');
const observedAt = new Date(now).toISOString();
const product = (sku, stock_quantity) => ({ sku, description: 'Victron MultiPlus', currency: 'ZAR',
  price: 525, enduser_price_zar: { price: 1000 }, stock_quantity });
const item = (sku, quantity) => ({ Code: sku, ItemID: `item-${sku}`, Name: `Victron ${sku}`,
  IsPurchased: true, IsTrackedAsInventory: true, QuantityOnHand: quantity, PurchaseDetails: { UnitPrice: 525 } });

test('canonical predecessor retirement remains literal even when its successor has stock', () => {
  for (const [oldStock, newStock, expected] of [[0, 10, true], [3, 0, false], [undefined, 0, false]]) {
    const rows = reviewCatalogue({ catalogue: [product(predecessor, 0), product(successor, 10)],
      items: { 'thanda-solar': [item(predecessor, oldStock), item(successor, newStock)], 'sensible-solar': [] },
      successions, observedAt, now });
    const retired = rows.find(candidate => candidate.company === 'thanda-solar' && candidate.sku === predecessor);
    assert.equal(retired.kind, 'archive');
    assert.equal(archiveReadiness(retired).ready, expected);
    assert.deepEqual(retired.replacedBy, [successor]);
  }
});

test('a saved zero never bypasses the existing complete-observation retirement gate', () => {
  const catalogue = [product(successor, 10)];
  const initial = { [predecessor]: { day: '2026-11-24', absentDays: 0 } };
  const first = advanceHistory(initial, catalogue, '2026-11-25', successions, '2026-11-25T08:00:00Z');
  const repeated = advanceHistory(first, catalogue, '2026-11-25', successions, '2026-11-25T08:00:00Z');
  const second = advanceHistory(repeated, catalogue, '2026-11-26', successions, observedAt);
  for (const [history, expected] of [[first, false], [repeated, false], [second, true]]) {
    const rows = reviewCatalogue({ catalogue, items: { 'thanda-solar': [item(predecessor, 0)], 'sensible-solar': [] },
      history, successions, observedAt, now });
    const retired = rows.find(candidate => candidate.company === 'thanda-solar' && candidate.sku === predecessor);
    assert.equal(archiveReadiness(retired).ready, expected);
  }
});
