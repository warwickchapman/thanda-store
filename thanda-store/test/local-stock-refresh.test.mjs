import assert from 'node:assert/strict';
import test from 'node:test';
import { queueStaleLocalStockRefresh, requestLocalStockRefresh } from '../src/lib/local-stock-refresh.mjs';

const now = Date.parse('2026-10-23T12:00:00Z');
const timestamp = minutes => new Date(now + minutes * 60_000).toISOString();
function database(row = {}) {
  const calls = [];
  return { calls, query: async sql => {
    calls.push(sql);
    if (sql.startsWith('SELECT')) return { rows: [row] };
    assert.match(sql, /^INSERT INTO xero_stock_sync_state/);
    return { rows: [{ ...row, refresh_requested_at: timestamp(0) }] };
  } };
}

test('fresh source observations need no queued refresh on an admin visit', async () => {
  const db = database({ observed_at: timestamp(-10) });
  const state = await queueStaleLocalStockRefresh(db, { now });
  assert.equal(state.pending, false);
  assert.equal(db.calls.length, 1);
});

test('stale or absent source queues the existing importer once; pending requests are retained', async () => {
  for (const observed_at of [timestamp(-36), null]) {
    const db = database({ observed_at });
    const state = await queueStaleLocalStockRefresh(db, { now });
    assert.equal(state.pending, true);
    assert.equal(state.requestedAt, timestamp(0));
    assert.equal(db.calls.length, 2);
    assert.match(db.calls[1], /COALESCE\(xero_stock_sync_state\.refresh_requested_at/);
  }
  const pending = database({ observed_at: timestamp(-40), refresh_requested_at: timestamp(-5) });
  assert.equal((await queueStaleLocalStockRefresh(pending, { now })).requestedAt, timestamp(-5));
  assert.equal(pending.calls.length, 1);
});

test('a recent attempt prevents repeated stale-cache refreshes from page visits', async () => {
  const db = database({ observed_at: timestamp(-60), last_started_at: timestamp(-10) });
  assert.equal((await queueStaleLocalStockRefresh(db, { now })).pending, false);
  assert.equal(db.calls.length, 1);
  const eligible = database({ observed_at: timestamp(-60), last_started_at: timestamp(-15) });
  assert.equal((await queueStaleLocalStockRefresh(eligible, { now })).pending, true);
});

test('future observations cannot conceal stale data or permanently block refresh attempts', async () => {
  for (const row of [{ observed_at: timestamp(6) }, { observed_at: timestamp(-60), last_started_at: timestamp(6) }]) {
    const db = database(row);
    assert.equal((await queueStaleLocalStockRefresh(db, { now })).pending, true);
    assert.equal(db.calls.length, 2);
  }
  const allowedSkew = database({ observed_at: timestamp(5) });
  assert.equal((await queueStaleLocalStockRefresh(allowedSkew, { now })).pending, false);
});

test('a confirmed catalogue change advances pending work; normal page visits coalesce it', async () => {
  for (const afterChange of [false, true]) {
    const db = database({ refresh_requested_at: timestamp(-10) });
    const result = await requestLocalStockRefresh(db, { afterChange });
    assert.equal(result.pending, true);
    assert.match(db.calls[0], afterChange ? /GREATEST\(/ : /COALESCE\(/);
  }
});
