import test from 'node:test';
import assert from 'node:assert/strict';
import { stockHealthIssues, sourceRecovery } from '../src/lib/data-health-actions.mjs';
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
  assert.match(issues[0].reason, /not found/);
  assert.match(issues[1].remedy, /bookkeeper/);
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
test('rate limits and authentication have different recovery instructions without leaking errors', () => {
  const rateLimit = sourceRecovery({ ...source('victron'), status: 'error', lastError: 'Source request failed (HTTP 429). token=secret' });
  assert.match(rateLimit[0], /cooldown/);
  assert.match(rateLimit[0], /do not repeatedly refresh/);
  assert.ok(!rateLimit.join('').includes('secret'));
  const auth = sourceRecovery({ ...source('thanda'), status: 'error', lastError: 'HTTP 401' });
  assert.match(auth[0], /shared Xero Hub/);
});
