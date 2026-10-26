import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteBackorders } from '../src/lib/commerce/quote-backorders.mjs';

const now = new Date('2026-10-26T10:00:00Z');
const recent = '2026-10-26T09:55:00.000Z';
const predecessor = 'PMP482305010';
const successor = 'PMP482305012';
const product = sku => ({ supplier: 'victron', sku });
const backorder = (sku = successor, extra = {}) => ({
  order_number: 'SO-1', sku, quantity: 4, planned_for: '2026-11-10', reference: null, ignored_sku: null, ...extra,
});

function harness({ accepted = {}, orders = {}, backorders = [backorder()], inbound = [], reservations = [], failure } = {}) {
  const calls = [];
  const db = { query: async (sql, parameters) => {
    calls.push({ sql, parameters });
    assert.match(sql.trim(), /^SELECT\b/, 'quote evidence must remain read-only');
    if (failure && sql.includes(failure.match)) throw Object.assign(new Error('Fixture database failure'), { code: failure.code });
    if (sql.includes('FROM data_sync_status')) return { rows: [{ last_status: 'success', source_observed_at: recent, last_error: null, ...accepted }] };
    if (sql.includes('FROM victron_order_sync_state')) return { rows: [{
      last_started_at: '2026-10-26T09:54:00Z', last_completed_at: recent,
      last_successful_sync_at: recent, last_error: null, ...orders,
    }] };
    if (sql.includes('FROM victron_sku_successions')) return { rows: [{ predecessor_sku: predecessor, successor_sku: successor }] };
    if (sql.includes('FROM renogy_sku_successions')) return { rows: [] };
    if (sql.includes('FROM victron_provisional_backorder_order_lines')) return { rows: backorders };
    if (sql.includes('FROM supplier_inbound_order_lines')) return { rows: inbound };
    if (sql.includes('FROM xero_accepted_quote_lines')) return { rows: reservations };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  return { db, calls };
}

test('current stored planned supply supports only the fulfilled article and its retail alias', async () => {
  const h = harness({ backorders: [backorder(`${successor}R`), backorder(predecessor, { order_number: 'SO-2', quantity: 100 })] });
  assert.deepEqual(await quoteBackorders(h.db, [product(successor)], now), [{
    sku: successor, quantity: 4, planned_for: '2026-11-10', observed_at: recent, last_error: null,
  }]);
  assert.deepEqual(h.calls.find(call => call.sql.includes('FROM victron_provisional_backorder_order_lines')).parameters, [[successor]]);
});

test('missing, stale, future or unsuccessful reservation observations cannot establish uncommitted supply', async () => {
  for (const accepted of [
    { source_observed_at: null },
    { source_observed_at: '2026-10-26T07:59:00Z', last_successful_at: recent },
    { source_observed_at: '2026-10-26T10:05:01Z' },
    { last_status: 'failed' }, { last_status: 'partial' }, { last_status: 'running' },
    { last_error: 'Last import failed' },
  ]) {
    const h = harness({ accepted });
    assert.deepEqual(await quoteBackorders(h.db, [product(successor)], now), []);
    assert.equal(h.calls.length, 2, 'unreliable source stops before reading supply');
  }
});

test('stale, failed and currently running E-Order imports do not refresh retained planned dates', async () => {
  for (const orders of [
    { last_completed_at: '2026-10-26T06:59:00Z', last_successful_sync_at: '2026-10-26T06:59:00Z', last_started_at: '2026-10-26T06:58:00Z' },
    { last_completed_at: '2026-10-26T10:05:01Z', last_successful_sync_at: '2026-10-26T10:05:01Z' },
    { last_completed_at: null }, { last_successful_sync_at: null },
    { last_error: 'Last sync failed' },
    { last_completed_at: '2026-10-26T09:59:00Z' },
    { last_started_at: '2026-10-26T09:59:00Z' },
  ]) {
    const h = harness({ orders });
    assert.deepEqual(await quoteBackorders(h.db, [product(successor)], now), []);
  }
});

test('an accepted predecessor reservation withholds successor supply for the canonical family', async () => {
  const h = harness({ reservations: [{ sku: `${predecessor}R`, quantity: 1 }] });
  assert.deepEqual(await quoteBackorders(h.db, [product(successor)], now), []);
  const unrelated = harness({ reservations: [{ sku: 'BPP900400100', quantity: 10 }] });
  assert.equal((await quoteBackorders(unrelated.db, [product(successor)], now)).length, 1);
  assert.match(h.calls.find(call => call.sql.includes('FROM xero_accepted_quote_lines')).sql, /reservation_eligible = true/);
});

test('inbound quantities exclude only matching order and canonical family, while ignored and RMA dates are never used', async () => {
  const h = harness({
    inbound: [{ order_number: 'SO-1', sku: `${predecessor}R` }],
    backorders: [
      backorder(), backorder(successor, { order_number: 'SO-2' }),
      backorder(successor, { order_number: 'SO-3', ignored_sku: successor }),
      backorder(successor, { order_number: 'SO-4', reference: 'RMA control' }),
    ],
  });
  const result = await quoteBackorders(h.db, [product(successor)], now);
  assert.equal(result.length, 1);
  assert.equal(result[0].quantity, 4);
  assert.match(h.calls.find(call => call.sql.includes('FROM supplier_inbound_order_lines')).sql,
    /ordered_quantity > line\.received_quantity/);
});

test('retail/base supply aliases and repeated selected articles cannot spend one physical balance twice', async () => {
  const h = harness({ backorders: [backorder(), backorder(`${successor}R`)] });
  assert.deepEqual(await quoteBackorders(h.db, [product(successor)], now), []);
  const duplicateSelection = harness();
  assert.deepEqual(await quoteBackorders(duplicateSelection.db, [product(successor), product(`${successor}R`)], now), []);
  assert.equal(duplicateSelection.calls.length, 0);
});

test('invalid, elapsed and quantity-free plans do not become estimates', async () => {
  for (const patch of [
    { planned_for: null }, { planned_for: '2026-10-25' }, { planned_for: '2026-10-26' },
    { planned_for: '2026-02-30' }, { planned_for: 'perhaps next month' },
    { quantity: 0 }, { quantity: null }, { quantity: 1.5 },
  ]) {
    const h = harness({ backorders: [backorder(successor, patch)] });
    assert.deepEqual(await quoteBackorders(h.db, [product(successor)], now), []);
  }
});

test('optional cache absence has a generic fallback, while real database failures stay visible', async () => {
  for (const match of ['FROM data_sync_status', 'FROM victron_order_sync_state', 'FROM victron_provisional_backorder_order_lines',
    'FROM victron_sku_successions', 'FROM xero_accepted_quote_lines']) {
    const missing = harness({ failure: { match, code: '42P01' } });
    assert.deepEqual(await quoteBackorders(missing.db, [product(successor)], now), []);
  }
  const unavailable = harness({ failure: { match: 'FROM data_sync_status', code: 'ECONNREFUSED' } });
  await assert.rejects(quoteBackorders(unavailable.db, [product(successor)], now), { code: 'ECONNREFUSED' });
  const irrelevant = harness();
  assert.deepEqual(await quoteBackorders(irrelevant.db, [{ supplier: 'renogy', sku: successor }], now), []);
  assert.equal(irrelevant.calls.length, 0);
});
