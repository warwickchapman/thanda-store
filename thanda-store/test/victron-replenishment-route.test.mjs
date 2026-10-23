import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { DATA_SOURCES, supplierStockObservation } from '../src/lib/data-freshness.mjs';
import { loadInventoryScope } from '../src/lib/inventory-scope.mjs';
import { stockSku, predecessorSkusForFamily, victronSkuFamilyResolver } from '../src/lib/victron-sku-family.mjs';
import { backorderQuantityAfterInbound } from '../src/lib/victron-order-sync.mjs';
import * as replenishment from '../src/lib/victron-replenishment.mjs';

// Run the real report route. All stock-scope and planning logic is real; only
// admin auth and local SQL reads are replaced. No provider client is present.
const compiled = ts.transpileModule(fs.readFileSync(new URL('../src/app/api/admin/replenishment/route.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const checkedAt = '2026-10-14T12:00:00.000Z';
const observedAt = '2026-10-14T11:30:00.000Z';
const successions = [{ predecessor_sku: 'PMP482305010', successor_sku: 'PMP482305012' }];
const supplierProduct = (sku = 'PMP482305012') => ({ sku, supplier: 'victron', name: 'Victron MultiPlus', price: 100,
  stock_on_hand: 8, price_break_qty: null, price_break_price: null,
  details: { supplierObservedAt: observedAt, supplierStockStatus: 'known', xeroStockStatus: 'missing', xeroStockSyncedAt: observedAt } });
const tracked = (sku, quantity) => ({ Code: sku, ItemID: `item-${sku}`, Name: 'Victron MultiPlus', IsTrackedAsInventory: true, QuantityOnHand: quantity });

async function harness(options = {}) {
  const products = options.products || [supplierProduct()];
  const sourceRuns = options.runs || ['thanda', 'sales', 'victron-orders', 'accepted-quotes'].map(source_id => ({
    source_id, last_status: 'success', source_observed_at: observedAt, last_successful_at: observedAt,
  }));
  const scope = await loadInventoryScope({ query: async sql => ({ rows: sql.includes('FROM thanda_inventory_evidence')
    ? [{ company: 'thanda-solar', observed_at: observedAt, snapshot: 'items-1', items: options.items || [],
      previously_tracked: options.previouslyTracked || {}, known_victron_codes: [] }]
    : options.requirements || [] }) }, { products: options.stockProducts || products,
    successions: options.successions || successions, runs: sourceRuns, now: checkedAt });
  const queries = [], healthOptions = [];
  const pool = { query: async sql => {
    queries.push(sql);
    if (sql.includes('FROM products')) return { rows: products };
    if (sql.includes('FROM xero_sales_invoice_lines')) return { rows: options.sales || [] };
    if (sql.includes('FROM supplier_inbound_orders inbound')) return { rows: [] };
    if (sql.includes('FROM supplier_inbound_order_lines')) return { rows: options.inbound || [] };
    if (sql.includes('FROM victron_provisional_backorder_order_lines')) {
      assert.match(sql, /ignored\.sku IS NULL/, 'ignored backorders remain excluded from purchase planning');
      return { rows: options.backorders || [] };
    }
    if (sql.includes('FROM victron_stock_minima')) return { rows: options.minimums || [] };
    if (sql.includes('FROM victron_replenishment_notes')) return { rows: [] };
    if (sql.includes('FROM victron_provisional_cart_lines')) return { rows: options.cart || [] };
    if (sql.includes('FROM xero_accepted_quote_lines')) return { rows: options.quotes || [] };
    if (sql.includes('FROM xero_accepted_quote_sync_state')) return { rows: [{ last_successful_sync_at: observedAt, last_error: null, last_stats: {} }] };
    if (sql.includes('FROM victron_sku_successions')) return { rows: options.successions || successions };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const dataHealth = { checkedAt, sources: DATA_SOURCES.map(source => ({ ...source, status: 'current',
    observedAt, totalCount: 1, missingCount: 0, lastRunStatus: 'success' })),
    inventoryScope: options.noScope ? undefined : options.scope || scope };
  const errors = [];
  const modules = {
    'next/server': { NextResponse: Response },
    '@/lib/db': pool,
    '@/lib/auth/server': { currentUser: async () => options.user === undefined ? { role: 'admin' } : options.user },
    '@/lib/auth/schema': { ensureAuthSchema: async () => {} },
    '@/lib/victron-sku': { victronStockSku: stockSku },
    '@/lib/victron-sku-family.mjs': { predecessorSkusForFamily, victronSkuFamilyResolver },
    '@/lib/victron-order-sync.mjs': { backorderQuantityAfterInbound },
    '@/lib/data-freshness': { getDataHealth: async settings => { healthOptions.push({ ...settings }); return dataHealth; } },
    '@/lib/data-freshness.mjs': { supplierStockObservation },
    '@/lib/victron-replenishment.mjs': replenishment,
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => {
    assert.ok(name in modules, `Unexpected import ${name}`);
    return modules[name];
  }, Response, Date, Set, Map, Error, console: { error: (...args) => errors.push(args) } });
  return { queries, healthOptions, errors, get: async () => {
    const response = await exports.GET();
    return { status: response.status, body: await response.json() };
  } };
}

test('report uses shared snapshot scope and retains predecessor demand without requiring inactive successor stock', async () => {
  const current = supplierProduct();
  const h = await harness({ stockProducts: [{ ...current, sku: 'PMP482305010', details: { hidden: true } }, current],
    items: [tracked('PMP482305010', 5)],
    requirements: [{ sku: 'PMP482305010', signal: 'Recorded sales or credit activity' }],
    sales: [{ sku: 'PMP482305010', sales_30: 30, sales_90: 45, last_sold_at: '2026-10-13' }] });
  const result = await h.get();
  assert.equal(result.status, 200);
  assert.deepEqual(h.healthOptions, [{ includeInventoryScope: true }]);
  assert.equal(result.body.items.length, 1);
  const item = result.body.items[0];
  assert.equal(item.sku, 'PMP482305012');
  assert.equal(item.localStock, 5);
  assert.equal(item.sales30, 30);
  assert.equal(item.suggestedOrder, 9);
  assert.equal(item.confidence, 'current');
  assert.deepEqual(item.predecessorSkus, ['PMP482305010']);
  assert.deepEqual(item.catalogueOnlySkus, ['PMP482305012']);
  assert.equal(h.queries.filter(sql => sql.includes('FROM products')).length, 1, 'no second independent local-stock query');
});

test('report preserves partial stock and withholds orders for active missing predecessor inventory', async () => {
  const h = await harness({ items: [tracked('PMP482305012', 2)],
    previouslyTracked: { PMP482305010: observedAt },
    requirements: [{ sku: 'PMP482305010', signal: 'Recorded sales or credit activity' }],
    sales: [{ sku: 'PMP482305010', sales_30: 30, sales_90: 45, last_sold_at: '2026-10-13' }] });
  const result = await h.get();
  assert.equal(result.status, 200);
  const item = result.body.items[0];
  assert.equal(item.localStock, null);
  assert.equal(item.knownLocalStock, 2);
  assert.equal(item.suggestedOrder, null);
  assert.equal(item.confidence, 'unavailable');
  assert.match(item.itemReviewReasons.join(' '), /PMP482305010/);
});

test('one planning item combines distinct predecessor and successor stock, demand and commitments across a replacement chain', async () => {
  const chain = [...successions, { predecessor_sku: 'PMP482305012', successor_sku: 'PMP482305014' }];
  const current = supplierProduct('PMP482305014');
  const h = await harness({
    successions: chain,
    products: [current, supplierProduct('PMP482305014R')],
    stockProducts: [
      { ...supplierProduct('PMP482305010'), details: { hidden: true } },
      { ...supplierProduct('PMP482305012'), details: { hidden: true } },
      current, supplierProduct('PMP482305014R'),
    ],
    items: [tracked('PMP482305010', 2), tracked('PMP482305012', 3),
      tracked('PMP482305014', 4), tracked('PMP482305014R', 4)],
    sales: [
      { sku: 'PMP482305010', sales_30: 30, sales_90: 45, last_sold_at: '2026-10-10' },
      { sku: 'PMP482305012', sales_30: 15, sales_90: 30, last_sold_at: '2026-10-13' },
    ],
    inbound: [{ sku: 'PMP482305010', quantity: 1, order_number: 'SO-1' }],
    cart: [{ sku: 'PMP482305012R', quantity: 2, uploaded_at: observedAt }],
    quotes: [{ sku: 'PMP482305012', quantity: 2, quote_id: 'quote-1',
      quote_number: 'QU-1', description: 'Victron MultiPlus' }],
    minimums: [{ sku: 'PMP482305010', minimum_stock: 5 }, { sku: 'PMP482305014', minimum_stock: 7 }],
  });
  const result = await h.get();
  assert.equal(result.status, 200);
  assert.equal(result.body.items.length, 1, 'one operational item represents the full replacement family');
  const item = result.body.items[0];
  assert.equal(item.sku, 'PMP482305014');
  assert.equal(item.localStock, 9, 'distinct Xero article balances add once; retail packaging is not another stock balance');
  assert.equal(item.knownLocalStock, 9);
  assert.equal(item.sales30, 45);
  assert.equal(item.sales90, 75);
  assert.equal(item.inbound, 1);
  assert.equal(item.provisional, 2);
  assert.equal(item.reserved, 2);
  assert.equal(item.minimumStock, 7, 'a family has one stocking floor');
  assert.equal(item.supplierStock, 8, 'supplier availability remains the selected ordering SKU quantity');
  assert.equal(item.suggestedOrder, 11);
  assert.equal(item.confidence, 'current', item.reviewReasons.join('; '));
  assert.deepEqual(item.predecessorSkus, ['PMP482305010', 'PMP482305012']);
});

test('open inbound and unignored backorder-only families remain visible without inventing demand', async () => {
  for (const field of ['inbound', 'backorders']) {
    const h = await harness({ items: [tracked('PMP482305012', 0)],
      [field]: [{ sku: 'PMP482305012', quantity: 3, order_number: 'SO-1' }] });
    const result = await h.get();
    assert.equal(result.status, 200);
    assert.equal(result.body.items.length, 1, field);
    const item = result.body.items[0];
    assert.equal(item.localStock, 0);
    assert.equal(item.sales30, 0);
    assert.equal(item.suggestedOrder, 0, 'an obligation alone is not a target demand');
  }
});

test('incomplete scope keeps known inventory visible but marks any calculable recommendation provisional', async () => {
  const h = await harness({ successions: [], runs: [], items: [tracked('PMP482305012', 2)],
    sales: [{ sku: 'PMP482305012', sales_30: 30, sales_90: 45, last_sold_at: '2026-10-13' }] });
  const result = await h.get();
  assert.equal(result.status, 200);
  const item = result.body.items[0];
  assert.equal(item.localStock, 2);
  assert.equal(item.suggestedOrder, 12);
  assert.equal(item.confidence, 'provisional');
  assert.match(item.itemReviewReasons.join(' '), /source evidence is missing, overdue or incomplete/);
  assert.deepEqual(item.catalogueOnlySkus, []);
});

test('missing scope fails closed and unauthorised access makes no planning queries', async () => {
  const h = await harness({ noScope: true });
  const failed = await h.get();
  assert.equal(failed.status, 500);
  assert.equal(failed.body.items, undefined);
  assert.equal(h.errors.length, 1);
  const unauthorised = await harness({ user: null });
  assert.equal((await unauthorised.get()).status, 403);
  assert.equal(unauthorised.queries.length, 0);
  assert.equal(unauthorised.healthOptions.length, 0);
});
