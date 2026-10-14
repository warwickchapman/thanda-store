import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as freshness from '../src/lib/data-freshness.mjs';
import * as actions from '../src/lib/data-health-actions.mjs';
import * as reviews from '../src/lib/stock-review.mjs';

const compiled = ts.transpileModule(fs.readFileSync(new URL('../src/lib/data-freshness.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const product = (sku, status, quantity, details = {}) => ({ supplier: 'victron', sku, name: sku, stock_on_hand: 0,
  details: { xeroStockStatus: status, localStockOnHand: quantity, xeroStockSyncedAt: new Date().toISOString(), supplierObservedAt: new Date().toISOString(), ...details } });

async function healthFor({ products = [], scope, run = {}, includeInventoryScope = false }) {
  const queries = [];
  const now = new Date().toISOString();
  const modules = {
    '@/lib/db': { query: async query => {
      queries.push(query);
      return { rows: query.startsWith('SELECT supplier, sku, name') ? products
        : query === 'SELECT * FROM data_sync_status' ? [{ source_id: 'thanda', last_status: 'success', ...run }]
        : query.includes('victron_order_sync_state') ? [{ last_successful_sync_at: now }] : [] };
    } },
    './data-freshness.mjs': freshness,
    './data-health-actions.mjs': actions,
    './stock-review.mjs': reviews,
    './inventory-scope.mjs': { loadInventoryScope: async (_, context) => {
      assert.equal(context.products.length, products.length, 'hidden and retired articles are assessed too');
      assert.ok(context.successions);
      const orders = context.runs.find(row => row.source_id === 'victron-orders');
      assert.equal(orders.last_status, 'success', 'legacy order evidence is reused');
      assert.equal(orders.source_observed_at, now);
      return scope;
    } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected import ${name}`);
    return modules[name];
  }, fetch: () => { throw new Error('Data health must not call a provider'); } });
  const health = await exports.getDataHealth({ includeIssues: true, includeInventoryScope });
  assert.ok(queries.every(query => query.startsWith('SELECT')), 'status remains read-only');
  return health;
}
const scopeFor = (stockProducts, catalogueOnly = []) => ({ stockProducts, catalogueOnly, articles: new Map(), complete: true, reason: null, observedAt: new Date().toISOString() });

test('expected catalogue omissions are informational; required stock remains diagnostic with no duplicate Victron worklist', async () => {
  const candidates = [product('PIN121250500', 'missing', null), product('SPM040303604', 'missing', null)];
  const required = [product('PMP482305012', 'tracked', null, { inventoryScope: 'required' }),
    product('OLD-HIDDEN', 'missing', null, { inventoryScope: 'required', hidden: true, purchasingRetiredReason: 'replaced' }),
    product('KNOWN-ZERO', 'tracked', 0, { inventoryScope: 'required' })];
  const lora = { ...product('LORA-MISSING', 'missing', null), supplier: 'lora' };
  const scope = scopeFor(required, candidates.map(row => ({ sku: row.sku, reason: 'Saved absence with no stocking requirement' })));
  const health = await healthFor({ products: [...candidates, ...required, lora], scope });
  assert.deepEqual(Array.from(health.stockReviews, item => `${item.supplier}:${item.sku}`), ['lora:LORA-MISSING']);
  const local = health.sources.find(source => source.id === 'thanda');
  assert.equal(local.status, 'missing');
  assert.equal(local.catalogueOnlyCount, 2);
  assert.equal(local.totalCount, 4);
  assert.equal(local.missingCount, 3);
  assert.deepEqual(Array.from(local.issues, item => item.sku), ['LORA-MISSING', 'OLD-HIDDEN', 'PMP482305012']);
  assert.match(local.issues.find(item => item.sku === 'PMP482305012').reason, /usable stock quantity/);
  assert.equal(health.inventoryScope, undefined, 'internal maps are not sent by normal status requests');
  assert.equal(health.sources.find(source => source.id === 'victron').totalCount, 4, 'hidden supplier products are not added to supplier health');
});

test('Data health and planning receive the same internal assessment; tracked zero is known', async () => {
  const known = product('ZERO', 'tracked', 0, { inventoryScope: 'required' });
  const scope = scopeFor([known]);
  const health = await healthFor({ products: [known], scope, includeInventoryScope: true });
  assert.equal(health.inventoryScope, scope);
  assert.equal(health.sources.find(source => source.id === 'thanda').status, 'current');
});

test('unconfirmed scope cannot silence missing inventory', async () => {
  const unknown = product('UNKNOWN', 'missing', null, { inventoryScope: 'unknown', inventoryRequirementReasons: ['Incomplete saved evidence'] });
  const scope = { ...scopeFor([unknown]), complete: false, reason: 'Inventory scope cannot be confirmed.' };
  const health = await healthFor({ products: [unknown], scope });
  const local = health.sources.find(source => source.id === 'thanda');
  assert.equal(local.status, 'missing');
  assert.equal(local.catalogueOnlyCount, 0);
  assert.match(local.issues[0].reason, /Cannot confirm/);
  assert.equal(local.inventoryScopeMessage, scope.reason);
});

for (const state of ['fresh', 'failed', 'stale', 'unimported']) {
  test(`empty inventory subset retains ${state} collection evidence rather than manufacturing zero or health`, async () => {
    const scope = scopeFor([]);
    const run = state === 'failed' ? { last_status: 'failed', last_error: 'Synthetic outage' } : {};
    if (state === 'stale') { scope.observedAt = new Date(Date.now() - 121 * 60_000).toISOString(); scope.complete = false; }
    if (state === 'unimported') { scope.observedAt = null; scope.complete = false; }
    const health = await healthFor({ scope, run });
    const local = health.sources.find(source => source.id === 'thanda');
    assert.equal(local.status, state === 'fresh' ? 'current' : state === 'failed' ? 'error' : state === 'stale' ? 'stale' : 'missing');
    assert.equal(local.totalCount, 0);
    assert.equal(local.missingCount, 0);
    assert.equal(local.observedAt, scope.observedAt);
  });
}
