import test from 'node:test';
import assert from 'node:assert/strict';
import { existingStoreProduct, matchingXeroItem, searchXeroProducts, storedXeroItems, validateStoreProduct, xeroStockDetails } from '../src/lib/admin/store-products.mjs';
import { productAvailability } from '../src/lib/catalogue-filters.mjs';
import { stockHealthIssues } from '../src/lib/data-health-actions.mjs';

const input = { name: ' Store name ', description: 'Useful description', category: 'Other products', price: '1250.50', visible: true };
const item = { ItemID: 'item-1', Code: 'SKU-1', Name: 'Xero name', Description: 'Sales description', IsSold: true, SalesDetails: { UnitPrice: 1200 }, IsTrackedAsInventory: true, QuantityOnHand: 5 };
const observedAt = '2026-10-01T08:00:00.000Z';

test('price and required content reject ambiguous or invalid input', () => {
  assert.equal(validateStoreProduct(input).name, 'Store name');
  assert.equal(validateStoreProduct(input).price, 1250.5);
  for (const price of ['', null, 0, -1, '1e3', '1.001', 'Infinity', '10000000000', '12,50']) {
    assert.throws(() => validateStoreProduct({ ...input, price }), /selling price/);
  }
  for (const field of ['name', 'description', 'category']) assert.throws(() => validateStoreProduct({ ...input, [field]: ' ' }), /required/);
  assert.throws(() => validateStoreProduct({ ...input, visible: 'yes' }), /visible/);
});

test('duplicates include hidden rows, item identity, case and Victron retail aliases', () => {
  const product = { id: 1, sku: 'sku-1', supplier: 'thanda', details: { hidden: true, storeManaged: true, xeroItemId: item.ItemID } };
  assert.equal(existingStoreProduct(item, [product]), product);
  assert.equal(existingStoreProduct({ ...item, Code: 'RENAMED' }, [product]), product);
  const victron = { id: 2, sku: 'PMP482305012', supplier: 'victron', details: {} };
  assert.equal(existingStoreProduct({ ...item, Code: 'PMP482305012R' }, [victron]), victron);
  assert.equal(existingStoreProduct({ ...item, Code: 'PMP482305010' }, [victron]), undefined);
});

test('search uses all words and excludes unsold items; explicit succession stays visible without merging SKUs', () => {
  const items = [item, { ...item, ItemID: 'not-for-sale', IsSold: false }, { ...item, ItemID: 'old', Code: 'PMP482305010' }, { ...item, ItemID: 'new', Code: 'PMP482305012' }];
  const successions = [{ predecessor_sku: 'PMP482305010', successor_sku: 'PMP482305012' }];
  const products = [{ id: 9, sku: 'PMP482305010', supplier: 'victron', details: {} }];
  assert.equal(searchXeroProducts(items, products, successions, 'sku-1 sales').total, 1);
  const result = searchXeroProducts(items, products, successions, 'PMP48230501');
  assert.equal(result.items[0].sku, 'PMP482305012');
  assert.equal(result.items[0].existing, null);
  assert.deepEqual(result.items[0].replaces, ['PMP482305010']);
  assert.deepEqual(result.items[1].replacedBy, ['PMP482305012']);
  assert.equal(result.items[1].existing.id, 9);
});

test('managed stock matches both original Xero identity and code, preserving unknown vs zero', () => {
  const product = { sku: item.Code, details: { storeManaged: true, xeroItemId: item.ItemID } };
  assert.equal(matchingXeroItem(product, new Map(), new Map([[item.ItemID, item]])), item);
  assert.equal(matchingXeroItem(product, new Map([[item.Code, { ...item, ItemID: 'replacement' }]]), new Map()), undefined);
  assert.equal(matchingXeroItem(product, new Map(), new Map([[item.ItemID, { ...item, Code: 'RENAMED' }]])), undefined);
  assert.equal(xeroStockDetails({ ...item, QuantityOnHand: 0 }, observedAt).localStockOnHand, 0);
  for (const changed of [{ ...item, QuantityOnHand: null }, { ...item, IsTrackedAsInventory: false }, undefined]) {
    assert.equal(xeroStockDetails(changed, observedAt).localStockOnHand, null);
  }
  const tracked = { supplier: 'thanda', stock_on_hand: null, details: { storeManaged: true, ...xeroStockDetails({ ...item, QuantityOnHand: 0 }, observedAt) } };
  assert.deepEqual(productAvailability(tracked), ['unavailable']);
  const missing = { ...tracked, details: { ...tracked.details, ...xeroStockDetails(undefined, observedAt) } };
  assert.deepEqual(productAvailability(missing), ['unknown']);
  assert.equal(stockHealthIssues({ id: 'thanda', mode: 'scheduled', staleAfterMinutes: 120 }, [missing]).length, 1);
  const service = { ...tracked, details: { ...tracked.details, ...xeroStockDetails({ ...item, IsTrackedAsInventory: false }, observedAt) } };
  assert.equal(stockHealthIssues({ id: 'thanda', mode: 'scheduled' }, [service]).length, 0);
});

test('Hub searches reject incomplete or unavailable evidence without live refreshes or retries', async t => {
  const previous = { url: process.env.XERO_HUB_URL, token: process.env.XERO_HUB_TOKEN };
  process.env.XERO_HUB_URL = 'http://hub.test'; process.env.XERO_HUB_TOKEN = 'synthetic';
  t.after(() => { for (const [key, value] of [['XERO_HUB_URL', previous.url], ['XERO_HUB_TOKEN', previous.token]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  let calls = 0;
  let payload = { Items: [item], _hub: { complete: true, snapshot: 'snapshot-1', observed_at: observedAt } };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++; assert.equal(url, 'http://hub.test/v1/thanda-solar/accounting/Items');
    assert.equal(init.method, undefined);
    return Response.json(payload);
  });
  assert.equal((await storedXeroItems()).items.length, 1);
  payload = { ...payload, _hub: { ...payload._hub, complete: false } };
  await assert.rejects(storedXeroItems, /incomplete/);
  assert.equal(calls, 2);
});
