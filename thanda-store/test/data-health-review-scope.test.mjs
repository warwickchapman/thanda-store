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

test('Data health has no second Victron worklist, but retains unknown stock and source diagnostics', async () => {
  const now = new Date().toISOString();
  const product = (supplier, sku, xeroStatus, localStock) => ({ supplier, sku, name: sku, stock_on_hand: 0,
    details: { xeroStockStatus: xeroStatus, localStockOnHand: localStock, xeroStockSyncedAt: now, supplierObservedAt: now } });
  const products = [
    product('victron', 'PIN121250500', 'missing', null),
    product('victron', 'SPM040303604', 'missing', null),
    product('victron', 'PMP482305012', 'tracked', null),
    product('lora', 'LORA-MISSING', 'missing', null),
    product('lora', 'LORA-ZERO', 'tracked', 0),
  ];
  const sql = [];
  const modules = {
    '@/lib/db': { query: async query => {
      sql.push(query);
      return { rows: query.startsWith('SELECT supplier, sku, name') ? products : [] };
    } },
    './data-freshness.mjs': freshness,
    './data-health-actions.mjs': actions,
    './stock-review.mjs': reviews,
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected import ${name}`);
    return modules[name];
  }, fetch: () => { throw new Error('Data health must not call a provider'); } });
  const health = await exports.getDataHealth({ includeIssues: true });
  assert.deepEqual(Array.from(health.stockReviews, item => `${item.supplier}:${item.sku}`), ['lora:LORA-MISSING']);
  const local = health.sources.find(source => source.id === 'thanda');
  assert.equal(local.status, 'missing');
  assert.equal(local.missingCount, 4);
  assert.equal(local.totalCount, 5);
  assert.deepEqual(local.issues.map(item => item.sku), ['LORA-MISSING', 'PIN121250500', 'PMP482305012', 'SPM040303604']);
  assert.match(local.issues.find(item => item.sku === 'PMP482305012').reason, /usable stock quantity/);
  assert.equal(health.sources.find(source => source.id === 'victron').missingCount, 0);
  assert.ok(!sql.some(query => query.includes('victron_sku_successions')), 'review-only succession reads are no longer needed');
  assert.ok(sql.every(query => query.startsWith('SELECT')), 'status remains read-only');
});
