import test from 'node:test';
import assert from 'node:assert/strict';
import { DATA_SOURCES, localStockObservation, supplierStockObservation, observeVictronSupplierStock, summarizeSource, safeSyncError } from '../src/lib/data-freshness.mjs';
import { ensureDataSyncSchema, startDataSync, finishDataSync } from '../src/lib/data-sync-state.mjs';

const now = new Date('2026-09-27T12:00:00Z');
const recent = '2026-09-27T11:55:00.000Z';
const old = '2026-09-27T06:00:00.000Z';
const source = id => DATA_SOURCES.find(row => row.id === id);

test('missing and untracked Xero items are unknown, while a tracked zero is known', () => {
  for (const status of ['missing', 'untracked', undefined]) {
    assert.deepEqual(localStockObservation({ details: { localStockOnHand: 0, xeroStockSyncedAt: recent, xeroStockStatus: status } }), { quantity: null, observedAt: recent });
  }
  assert.deepEqual(localStockObservation({ details: { localStockOnHand: 0, xeroStockSyncedAt: recent, xeroStockStatus: 'tracked' } }), { quantity: 0, observedAt: recent });
  assert.equal(localStockObservation({ details: { localStockOnHand: 7, xeroStockStatus: 'tracked' } }).quantity, null);
});

test('unknown supplier quantities remain unknown and product edits do not refresh them', () => {
  assert.equal(supplierStockObservation({ supplier: 'victron', stock_on_hand: 0, details: { supplierObservedAt: recent, supplierStockStatus: 'unknown' } }).quantity, null);
  assert.deepEqual(supplierStockObservation({ supplier: 'victron', stock_on_hand: 0, last_updated: recent, details: { supplierObservedAt: old } }), { quantity: 0, observedAt: old });
  assert.equal(supplierStockObservation({ supplier: 'renogy', stock_on_hand: 8, last_updated: recent }).quantity, null);
});

test('new Victron SKU imports preserve real observations, known zero and missing quantities', () => {
  for (const [product, expected] of [
    [{ all_stock_by_warehouse: { af_sa_inzuzo: 0 }, stock_quantity: 100 }, 0],
    [{ all_stock_by_warehouse: { af_sa_inzuzo: null }, stock_quantity: 7 }, 7],
    [{ all_stock_by_warehouse: { af_sa_inzuzo: 5 }, stock_quantity: 100 }, 5],
    [{ stock_quantity: null }, null],
    [{ stock_quantity: '' }, null],
    [{ stock_quantity: false }, null],
    [{}, null],
  ]) {
    const observation = observeVictronSupplierStock(product, recent);
    assert.equal(observation.quantity, expected);
    const saved = { supplier: 'victron', stock_on_hand: observation.quantity ?? 0,
      details: { supplierObservedAt: observation.observedAt, supplierStockStatus: observation.status } };
    assert.deepEqual(supplierStockObservation(saved), { quantity: expected, observedAt: recent });
  }
});

test('a recent partial update does not mask older observations or missing stock', () => {
  const row = summarizeSource(source('victron'), [
    { quantity: 4, observedAt: recent }, { quantity: 3, observedAt: old }, { quantity: null, observedAt: recent },
  ], { last_status: 'partial', last_error: 'Incomplete catalogue update' }, now);
  assert.equal(row.status, 'error');
  assert.equal(row.observedAt, old);
  assert.equal(row.latestObservedAt, recent);
  assert.equal(row.missingCount, 1);
  assert.equal(row.staleCount, 1);
});

test('import time does not make stale source evidence fresh', () => {
  const row = summarizeSource(source('thanda'), [{ quantity: 2, observedAt: old }], {
    last_status: 'success', last_successful_at: recent,
  }, now);
  assert.equal(row.status, 'stale');
  assert.equal(row.observedAt, old);
  assert.equal(row.lastSuccessAt, recent);
});

test('source schedules use their own warning thresholds', () => {
  const observations = [{ quantity: 0, observedAt: '2026-09-27T11:30:00Z' }];
  assert.equal(summarizeSource(source('renogy'), observations, {}, now).status, 'stale');
  assert.equal(summarizeSource(source('victron'), observations, {}, now).status, 'current');
  assert.equal(summarizeSource(source('sales'), [{ quantity: 1, observedAt: '2026-09-26T08:00:00Z' }], {}, now).status, 'current');
});

test('manual sources do not invent a sync timestamp or overdue failure', () => {
  for (const id of ['hubble', 'lora']) {
    const observations = [supplierStockObservation({ supplier: id, stock_on_hand: 0 })];
    const row = summarizeSource(source(id), observations, {}, now);
    assert.equal(row.status, 'manual');
    assert.equal(row.observedAt, null);
    assert.equal(row.staleCount, 0);
    assert.equal(row.missingCount, 0);
  }
});

test('missing sources and invalid future timestamps are not current', () => {
  assert.equal(summarizeSource(source('thanda'), [], {}, now).status, 'missing');
  assert.equal(summarizeSource(source('thanda'), [{ quantity: 2, observedAt: '2026-09-28T12:00:00Z' }], {}, now).status, 'missing');
});

test('sync error summaries do not expose error bodies, signed URLs or credentials', () => {
  assert.equal(safeSyncError('HTTP 401: token=private-secret url=https://example.com/signed?key=secret'), 'Source request failed (HTTP 401). Check the service log.');
  assert.equal(safeSyncError('password=secret'), 'The update failed. Check the service log.');
});

test('job persistence keeps bounded counts and source time distinct from run time', async () => {
  const calls = [];
  const db = { query: async (...args) => { calls.push(args); return { rows: [] }; } };
  await ensureDataSyncSchema(db);
  await startDataSync(db, 'victron');
  await finishDataSync(db, 'victron', { observedAt: old, counts: { synced: 12, details: ['secret'] } });
  const [, values] = calls.at(-1);
  assert.deepEqual(values, ['victron', 'success', old, null, '{"synced":12}']);
  await finishDataSync(db, 'victron', { status: 'failed', error: 'HTTP 503: signed-secret' });
  assert.ok(!JSON.stringify(calls.at(-1)).includes('signed-secret'));
});
