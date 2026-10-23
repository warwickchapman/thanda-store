import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as freshness from '../src/lib/data-freshness.mjs';
import * as actions from '../src/lib/data-health-actions.mjs';
import * as reviews from '../src/lib/stock-review.mjs';
import * as families from '../src/lib/victron-sku-family.mjs';

const compiled = ts.transpileModule(fs.readFileSync(new URL('../src/lib/data-freshness.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const product = (sku, status, quantity, details = {}) => ({ supplier: 'victron', sku, name: sku, stock_on_hand: 0,
  details: { xeroStockStatus: status, localStockOnHand: quantity, xeroStockSyncedAt: new Date().toISOString(), supplierObservedAt: new Date().toISOString(), ...details } });

async function healthFor({ products = [], scope, run = {}, includeInventoryScope = false, creations = [], extraRuns = [], catalogueReview = null, archives = [] }) {
  const queries = [];
  const now = new Date().toISOString();
  const modules = {
    '@/lib/db': { query: async query => {
      queries.push(query);
      return { rows: query.startsWith('SELECT supplier, sku, name') ? products
        : query === 'SELECT * FROM data_sync_status' ? [{ source_id: 'thanda', last_status: 'success', ...run }, ...extraRuns]
        : query.includes('FROM victron_catalogue_events e') ? creations
        : query.includes('FROM victron_catalogue_review WHERE') ? catalogueReview ? [catalogueReview] : []
        : query.includes("action='archive-reviewed'") ? archives
        : query.includes('victron_order_sync_state') ? [{ last_successful_sync_at: now }] : [] };
    } },
    './data-freshness.mjs': freshness,
    './data-health-actions.mjs': actions,
    './stock-review.mjs': reviews,
    './victron-sku-family.mjs': families,
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

test('supplier catalogue removals do not report failed stock observations or erase retained balances', async () => {
  const now = new Date().toISOString();
  const removed = product('BPP900400100', 'tracked', 3, { cataloguePresent: false, catalogueObservedAt: now,
    supplierObservedAt: '2026-09-01T10:00:00Z' });
  removed.stock_on_hand = 12;
  const health = await healthFor({ products: [removed], scope: scopeFor([removed]),
    extraRuns: [{ source_id: 'victron', source_observed_at: now, last_successful_at: now, last_status: 'success' }] });
  const supplier = health.sources.find(source => source.id === 'victron');
  assert.equal(supplier.feedStatus, 'current');
  assert.equal(supplier.status, 'current');
  assert.equal(supplier.totalCount, 0);
  assert.equal(supplier.missingCount, 0);
  assert.equal(supplier.staleCount, 0);
  assert.equal(supplier.actionableIssueCount, 0);
  assert.equal(supplier.lifecycleCount, 1);
  assert.deepEqual(Array.from(supplier.lifecycleItems, row => row.sku), ['BPP900400100']);
  assert.match(supplier.lifecycleReviewUrl, /victron-catalogue/);
  assert.equal(supplier.lastSuccessAt, now);
  assert.equal(removed.stock_on_hand, 12);
  assert.equal(removed.details.localStockOnHand, 3, 'owned and supplier balances stay separate');
});

test('a current supplier import still exposes genuinely missing stock alongside lifecycle records', async () => {
  const now = new Date().toISOString();
  const removed = product('BPP900400100', 'tracked', 0, { cataloguePresent: false, catalogueObservedAt: now });
  const missing = product('ORI121221040', 'tracked', 0, { supplierObservedAt: null });
  const health = await healthFor({ products: [removed, missing], scope: scopeFor([removed, missing]),
    extraRuns: [{ source_id: 'victron', source_observed_at: now, last_status: 'success' }] });
  const supplier = health.sources.find(source => source.id === 'victron');
  assert.equal(supplier.feedStatus, 'current');
  assert.equal(supplier.status, 'missing');
  assert.equal(supplier.lifecycleCount, 1);
  assert.equal(supplier.missingCount, 1);
  assert.equal(supplier.actionableIssueCount, 1);
  assert.deepEqual(Array.from(supplier.issues, row => row.sku), ['ORI121221040']);
  assert.equal(supplier.issues[0].owner, 'maintainer');
});

test('eleven retained supplier removals mirror five canonical Xero archive decisions and immediate recorded completions', async () => {
  const now = new Date().toISOString();
  const products = Array.from({ length: 11 }, (_, index) => product(`REMOVED${index}`, 'tracked', 0, {
    cataloguePresent: false, catalogueObservedAt: now,
  }));
  const rows = products.slice(0, 5).map(row => ({ company: 'thanda-solar', sku: row.sku, kind: 'archive' }));
  const history = Object.fromEntries(rows.map(row => [row.sku, { absentSince: '2026-09-27' }]));
  const catalogueReview = { checked_at: now, observed_at: now, rows, history };
  const options = { products, scope: scopeFor(products), catalogueReview,
    extraRuns: [{ source_id: 'victron', source_observed_at: now, last_status: 'success' }] };
  const first = (await healthFor(options)).sources.find(source => source.id === 'victron');
  assert.equal(first.lifecycleCount, 11);
  assert.equal(first.lifecycleActionCount, 5, 'unowned panels do not become eleven required archive decisions');
  assert.equal(first.feedStatus, 'current');
  assert.equal(first.actionableIssueCount, 0);
  const archives = rows.map(row => ({ company: row.company, sku: row.sku, completed_at: now }));
  const finished = (await healthFor({ ...options, archives })).sources.find(source => source.id === 'victron');
  assert.equal(finished.lifecycleCount, 11, 'retained source history remains visible');
  assert.equal(finished.lifecycleActionCount, 0, 'completion events clear work even before a successful comparison rebuild');
  const failedRefresh = (await healthFor({ ...options, archives,
    catalogueReview: { ...catalogueReview, error: 'Synthetic comparison refresh failed' } })).sources.find(source => source.id === 'victron');
  assert.equal(failedRefresh.lifecycleActionCount, null, 'failed comparison remains unknown rather than claiming everything is complete');
  assert.match(failedRefresh.lifecycleReviewMessage, /do not repeat/);
});

test('a confirmed addition waits for the existing import while planning retains its unknown balance', async () => {
  const beforeCreation = new Date(Date.now() - 30 * 60_000).toISOString();
  const confirmedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const pending = product('PMP482305012', 'missing', null, {
    inventoryScope: 'required', inventoryRequirementReasons: ['Confirmed Xero creation'],
  });
  const scope = { ...scopeFor([pending]), observedAt: beforeCreation };
  const health = await healthFor({ products: [pending], scope, includeInventoryScope: true,
    creations: [{ company: 'thanda-solar', sku: pending.sku, created_at: beforeCreation, confirmed_at: confirmedAt }] });
  const local = health.sources.find(source => source.id === 'thanda');
  assert.equal(local.feedStatus, 'current');
  assert.equal(local.status, 'current');
  assert.equal(local.missingCount, 0);
  assert.equal(local.actionableIssueCount, 0);
  assert.equal(local.awaitingStockImportCount, 1);
  assert.deepEqual(Array.from(local.awaitingStockImports, row => row.sku), [pending.sku]);
  assert.equal(health.inventoryScope, scope);
  assert.equal(health.inventoryScope.stockProducts[0].details.localStockOnHand, null);
  assert.equal(health.inventoryScope.stockProducts[0].details.xeroStockStatus, 'missing');
});

test('a newer saved inventory list missing a confirmed addition requires record investigation', async () => {
  const pending = product('PMP482305012', 'missing', null, {
    inventoryScope: 'required', inventoryRequirementReasons: ['Confirmed Xero creation'],
  });
  const scope = scopeFor([pending]);
  const health = await healthFor({ products: [pending], scope,
    creations: [{ company: 'thanda-solar', sku: pending.sku, created_at: new Date(Date.now() - 60_000).toISOString() }] });
  const local = health.sources.find(source => source.id === 'thanda');
  assert.equal(local.awaitingStockImportCount, 0);
  assert.equal(local.missingCount, 1);
  assert.equal(local.actionableIssueCount, 1);
  assert.equal(local.issues[0].kind, 'missing-record');
  assert.equal(local.issues[0].owner, 'bookkeeper');
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
