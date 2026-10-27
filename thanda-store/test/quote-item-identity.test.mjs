import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteItemIdentities } from '../src/lib/commerce/quote-item-identity.mjs';

const now = new Date('2026-10-27T06:10:00Z');
const timestamp = minutes => new Date(now.getTime() + minutes * 60_000).toISOString();
const renogy = { id: '7', supplier: 'renogy', sku: 'RBT12104LFP-SSL-BT-G2-SA',
  name: 'Renogy battery', recommended_retail_ex_vat: 14624, b2b_discount_percent: 30, details: {} };
const item = (Code = renogy.sku, ItemID = 'item-1') => ({ Code, ItemID });

function harness(patch = {}, rows) {
  const calls = [];
  const evidence = { company: 'thanda-solar', observed_at: timestamp(-5), snapshot: 'complete-revision', items: [item()], ...patch };
  return { calls, db: { query: async sql => {
    calls.push(sql);
    assert.match(sql.trim(), /^SELECT\b/);
    assert.match(sql, /FROM thanda_inventory_evidence WHERE id = true/);
    return { rows: rows || [evidence] };
  } } };
}

test('ordinary Renogy maps its literal saved Xero item without xeroStockStatus or provider access', async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('No Hub or provider calls are permitted.'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const h = harness();
  assert.deepEqual(await quoteItemIdentities(h.db, [renogy], now), new Map([[7, renogy.sku]]));
  assert.equal(h.calls.length, 1);
});

test('one saved snapshot resolves every supplier without altering product content, prices or quantities', async () => {
  const products = [renogy, { id: 8, supplier: 'victron', sku: 'pmp482605012', stock_on_hand: 4,
    details: { localStockOnHand: 2, xeroStockStatus: 'missing', privateSupplierCost: 123 } },
  { id: 9, supplier: 'enertec', sku: 'CTEK-1', details: {} }];
  const original = structuredClone(products);
  const h = harness({ items: [item(), item('PMP482605012', 'item-2'), item('CTEK-1', 'item-3')] });
  assert.deepEqual(await quoteItemIdentities(h.db, products, now), new Map([[7, renogy.sku], [8, 'PMP482605012'], [9, 'CTEK-1']]));
  assert.deepEqual(products, original);
  assert.equal(h.calls.length, 1);
});

test('store-managed identities require both their recorded ItemID and unchanged exact code', async () => {
  const product = { ...renogy, details: { storeManaged: true, xeroItemId: 'item-1' } };
  assert.equal((await quoteItemIdentities(harness().db, [product], now)).get(7), renogy.sku);
  for (const items of [[item(renogy.sku, 'new-owner')], [item('RENAMED', 'item-1')],
    [item(renogy.sku, 'new-owner'), item('RENAMED', 'item-1')]]) {
    assert.equal((await quoteItemIdentities(harness({ items }).db, [product], now)).get(7), null);
  }
  assert.equal((await quoteItemIdentities(harness().db,
    [{ ...product, details: { storeManaged: true } }], now)).get(7), null);
});

test('successors and Victron R packaging never supply another literal accounting code', async () => {
  const predecessor = { id: 1, supplier: 'victron', sku: 'PMP482305010', details: {} };
  const retail = { id: 2, supplier: 'victron', sku: 'PMP482305010R', details: {} };
  const h = harness({ items: [item('PMP482305012', 'successor'), item('PMP482305012R', 'successor-retail')] });
  assert.deepEqual(await quoteItemIdentities(h.db, [predecessor, retail], now), new Map([[1, null], [2, null]]));
  assert.deepEqual(await quoteItemIdentities(harness({ items: [item(predecessor.sku)] }).db, [predecessor, retail], now),
    new Map([[1, predecessor.sku], [2, null]]));
  assert.deepEqual(await quoteItemIdentities(harness({ items: [item(retail.sku)] }).db, [predecessor, retail], now),
    new Map([[1, null], [2, retail.sku]]));
});

test('reliable absence differs from missing or invalid evidence', async () => {
  assert.deepEqual(await quoteItemIdentities(harness({ items: [] }).db, [renogy], now), new Map([[7, null]]));
  assert.deepEqual(await quoteItemIdentities(harness({ items: [item('UNRELATED')] }).db, [renogy], now), new Map([[7, null]]));
  assert.equal(await quoteItemIdentities(harness({}, []).db, [renogy], now), null);
  for (const patch of [{ company: 'sensible-solar' }, { snapshot: null }, { snapshot: '' }, { snapshot: ' ' },
    { snapshot: 'x'.repeat(1001) }, { items: null }, { items: {} }, { items: '[]' },
    { observed_at: null }, { observed_at: 'invalid' }, { observed_at: timestamp(-120.01) },
    { observed_at: timestamp(5.01) }]) {
    assert.equal(await quoteItemIdentities(harness(patch).db, [renogy], now), null, JSON.stringify(patch));
  }
});

test('stock source observation windows retain boundary times and accept database Date values', async () => {
  for (const observed_at of [timestamp(-120), timestamp(5), new Date(timestamp(-5))]) {
    assert.equal((await quoteItemIdentities(harness({ observed_at }).db, [renogy], now)).get(7), renogy.sku);
  }
  assert.equal(await quoteItemIdentities(harness().db, [renogy], 'invalid'), null);
});

test('malformed items or duplicate code/ID identities invalidate the entire snapshot', async () => {
  for (const items of [[null], [{}], [{ Code: renogy.sku }], [{ ItemID: 'item-1' }],
    [item('', 'item-1')], [item(' ', 'item-1')], [item(renogy.sku, '')],
    [item(renogy.sku), item(renogy.sku.toLowerCase(), 'item-2')],
    [item(renogy.sku), item('OTHER', 'item-1')], [item(renogy.sku), item('OTHER', 'ITEM-1')],
    [item('x'.repeat(101))], [item(renogy.sku, 'x'.repeat(101))]]) {
    assert.equal(await quoteItemIdentities(harness({ items }).db, [renogy], now), null, JSON.stringify(items));
  }
});

test('missing optional schema is unavailable evidence while real database errors remain visible', async () => {
  const missing = { query: async () => { throw Object.assign(new Error('Missing fixture table'), { code: '42P01' }); } };
  assert.equal(await quoteItemIdentities(missing, [renogy], now), null);
  const unavailable = { query: async () => { throw Object.assign(new Error('Fixture connection failure'), { code: 'ECONNREFUSED' }); } };
  await assert.rejects(quoteItemIdentities(unavailable, [renogy], now), { code: 'ECONNREFUSED' });
  assert.deepEqual(await quoteItemIdentities({ query: () => { throw new Error('No products need no evidence read.'); } }, [], now), new Map());
});
