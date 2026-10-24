import assert from 'node:assert/strict';
import test from 'node:test';
import { selectPublicProducts } from '../src/lib/commerce/public-storefront.mjs';

const now = Date.parse('2026-10-24T10:00:00Z');
const observedAt = new Date(now - 60_000).toISOString();
const product = (overrides = {}) => ({
  id: 1, supplier: 'victron', sku: 'PMP482305012', name: 'MultiPlus-II', category: 'Inverter chargers',
  image_url: '', price: 9876.54, stock_on_hand: 500,
  details: { xeroStockStatus: 'tracked', xeroStockSyncedAt: observedAt, localStockOnHand: 3,
    distributorPrice: 'PRIVATE-DISTRIBUTOR-PRICE', distributorPriceExVat: 'PRIVATE-COST',
    recommendedRetailExVat: 19000, contactDiscount: 'PRIVATE-TRADE-DISCOUNT',
    supplierObservedAt: observedAt, supplierStockStatus: 'known' },
  ...overrides,
});
const configured = (sku = 'PMP482305012', overrides = {}) => ({ supplier: 'victron', sku,
  summary: 'Local product advice and support.', position: 1, ...overrides });
const select = (rows, config = [configured()], successions = [], options = {}) =>
  selectPublicProducts(rows, successions, config, { now, ...options });

test('public cards expose only the reviewed presentation fields, never raw catalogue or pricing data', () => {
  const row = product({ arbitraryPrivateField: 'PRIVATE-ROW-MARKER' });
  const before = structuredClone(row);
  const cards = select([row, product({ id: 2, sku: 'NOT-CONFIGURED' })]);
  assert.equal(cards.length, 1);
  assert.deepEqual(Object.keys(cards[0]).sort(), ['availability', 'category', 'id', 'imageUrl', 'name',
    'requestQuoteUrl', 'sku', 'summary', 'supplier'].sort());
  assert.deepEqual(Object.keys(cards[0].availability).sort(), ['local', 'observedAt']);
  assert.equal(cards[0].availability.local, 'in_stock');
  assert.doesNotMatch(JSON.stringify(cards), /PRIVATE-|9876\.54|19000|500|discount|price|details/i);
  assert.deepEqual(row, before, 'Selecting public products must not rewrite the source catalogue.');
  const quoteUrl = new URL(cards[0].requestQuoteUrl);
  assert.equal(quoteUrl.origin, 'https://store.thanda.solar');
  assert.equal(quoteUrl.pathname, '/request-quote');
  assert.equal(quoteUrl.searchParams.get('product'), '1');
});

test('hidden and restricted rows fail closed even when explicitly configured', () => {
  const forbidden = [
    product({ details: { hidden: true } }), product({ details: { hidden: 'true' } }),
    ...[null, {}, { allowedEmails: [] }, { allowedEmails: ['buyer@example.test'] }]
      .map(catalogueVisibility => product({ details: { catalogueVisibility } })),
    product({ supplier: 'enertec' }),
  ];
  for (const row of forbidden) {
    assert.deepEqual(select([row], [configured(row.sku, { supplier: row.supplier })]), []);
  }
  assert.deepEqual(select([product()], []), [], 'An empty reviewed selection must not publish the catalogue.');
});

test('confirmed Victron successor families select the newest visible imported article once', () => {
  const edges = [
    { supplier: 'victron', predecessor_sku: 'PMP482305010', successor_sku: 'PMP482305012' },
    { supplier: 'victron', predecessor_sku: 'PMP482305012', successor_sku: 'PMP482305014' },
  ];
  const previous = product({ id: 10, sku: 'PMP482305010', name: 'Previous article',
    details: { xeroStockStatus: 'tracked', xeroStockSyncedAt: observedAt, localStockOnHand: 99 } });
  const middle = product({ id: 12 });
  const newest = product({ id: 14, sku: 'PMP482305014', name: 'Newest article', details: {} });
  const config = [configured(previous.sku), configured(middle.sku, { position: 2 }), configured(newest.sku, { position: 3 })];
  const result = select([previous, middle, newest], config, edges);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 14);
  assert.equal(result[0].name, 'Newest article');
  assert.equal(result[0].availability.local, 'unknown', 'Stock evidence must stay on its actual article.');
  const hiddenNewest = { ...newest, details: { hidden: true } };
  assert.equal(select([previous, middle, hiddenNewest], [config[0]], edges)[0].id, 12);
  assert.equal(select([previous, middle], [config[0]], edges)[0].id, 12);
});

test('retail R aliases resolve to one article without inventing SKU succession', () => {
  const ordinary = product({ id: 1, sku: 'BPC121532024' });
  const retail = product({ id: 2, sku: 'BPC121532024R' });
  const result = select([retail, ordinary], [configured('bpc121532024r'), configured('BPC121532024', { position: 2 })]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 1);
  assert.deepEqual(select([product()], [configured('UNRELATED-SKU')]), []);
});

test('local availability requires fresh tracked evidence and never substitutes supplier stock', () => {
  const cases = [
    [{ xeroStockStatus: 'tracked', xeroStockSyncedAt: observedAt, localStockOnHand: 0 }, 'out_of_stock'],
    [{ xeroStockStatus: 'tracked', xeroStockSyncedAt: observedAt, localStockOnHand: 1 }, 'in_stock'],
    [{ xeroStockStatus: 'tracked', xeroStockSyncedAt: new Date(now - 121 * 60_000).toISOString(), localStockOnHand: 1 }, 'unknown'],
    [{ xeroStockStatus: 'tracked', xeroStockSyncedAt: new Date(now + 10 * 60_000).toISOString(), localStockOnHand: 1 }, 'unknown'],
    [{ xeroStockStatus: 'untracked', xeroStockSyncedAt: observedAt, localStockOnHand: 1 }, 'unknown'],
    [{ xeroStockStatus: 'tracked', localStockOnHand: 1 }, 'unknown'],
    [{ xeroStockStatus: 'tracked', xeroStockSyncedAt: observedAt, localStockOnHand: null }, 'unknown'],
    [{ supplierObservedAt: observedAt, supplierStockStatus: 'known' }, 'unknown'],
  ];
  for (const [details, expected] of cases) {
    assert.equal(select([product({ details })])[0].availability.local, expected, JSON.stringify(details));
  }
});

test('public images use reviewed cached thumbnails or unauthenticated official manufacturer URLs only', () => {
  const official = 'https://www.victronenergy.com/upload/products/MultiPlus.png';
  assert.equal(select([product({ image_url: official })])[0].imageUrl, official);
  const rejected = ['javascript:alert(1)', 'http://www.victronenergy.com/image.png',
    'https://www.victronenergy.com.evil.test/image.png', 'https://user:pass@www.victronenergy.com/image.png',
    'https://www.victronenergy.com:444/image.png', 'https://www.victronenergy.com/image.png?token=PRIVATE',
    'https://eorder.victronenergy.com/image.png', '/api/store-product-images/private', 'https://example.test/image.png'];
  for (const image_url of rejected) assert.equal(select([product({ image_url })])[0].imageUrl, null, image_url);
  assert.equal(select([product({ image_url: rejected[0] })], undefined, [], { hasThumbnail: () => true })[0].imageUrl,
    '/api/product-images/victron/PMP482305012');
  assert.equal(select([product({ sku: '../../private' })], [configured('../../private')], [], { hasThumbnail: () => true }).length, 0);
});

test('reviewed selection order is stable and no more than eight products become public', () => {
  const rows = Array.from({ length: 10 }, (_, index) => product({ id: index + 1, sku: `SKU${index + 1}` }));
  const config = rows.map((row, index) => configured(row.sku, { position: index + 1 })).reverse();
  assert.deepEqual(select(rows, config).map(row => row.id), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('only the explicitly reviewed LoRa article is published and an unreviewed image remains absent', () => {
  const reviewed = product({ id: 11, supplier: 'lora', sku: 'LORA-RS-HUB', name: 'LoRa RS Hub',
    image_url: 'https://lora.thanda.solar/unreviewed-product-image.png' });
  const unselected = product({ id: 12, supplier: 'lora', sku: 'LORA-RS-SENSOR', name: 'Unselected LoRa sensor' });
  const config = [configured(reviewed.sku, { supplier: 'lora', summary: 'Local wireless monitoring advice.' })];
  const result = select([reviewed, unselected], config);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 11);
  assert.equal(result[0].supplier, 'lora');
  assert.equal(result[0].imageUrl, null);
  assert.deepEqual(select([reviewed, unselected]), [], 'Adding a supplier must not publish its unselected catalogue.');
});
