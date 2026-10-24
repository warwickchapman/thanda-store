import assert from 'node:assert/strict';
import test from 'node:test';
import { selectPublicProducts } from '../src/lib/commerce/public-storefront.mjs';
import { favouritesWindowStart, rankedFavouriteProducts } from '../src/lib/favourite-products.mjs';

const now = Date.parse('2026-10-24T10:00:00Z');
const observedAt = new Date(now - 60_000).toISOString();
const product = (overrides = {}) => ({
  id: 1, supplier: 'victron', sku: 'PMP482305012', name: 'MultiPlus-II', category: 'Inverter chargers',
  image_url: '', price: 9876.54, stock_on_hand: 500, description: 'PRIVATE-SUPPLIER-DESCRIPTION',
  details: { xeroStockStatus: 'tracked', xeroStockSyncedAt: observedAt, localStockOnHand: 3,
    distributorPrice: 'PRIVATE-DISTRIBUTOR-PRICE', distributorPriceExVat: 'PRIVATE-COST',
    recommendedRetailExVat: 19000, contactDiscount: 'PRIVATE-TRADE-DISCOUNT',
    supplierObservedAt: observedAt, supplierStockStatus: 'known' },
  ...overrides,
});
const configured = (sku = 'PMP482305012', overrides = {}) => ({ supplier: 'victron', sku,
  summary: 'Local product advice and support.', position: 1, ...overrides });
const sale = (sku, quantity = 1, invoice_id = sku) => ({ sku, quantity, invoice_id, invoice_date: observedAt });
const select = (rows, config = [configured()], successions = [], options = {}) =>
  selectPublicProducts(rows, successions, options.history ?? config.map(item => sale(item.sku)), config, { now, ...options });

test('public cards expose only presentation fields, never sales, descriptions, raw catalogue or pricing data', () => {
  const row = product({ arbitraryPrivateField: 'PRIVATE-ROW-MARKER', description: 'PRIVATE-DESCRIPTION' });
  const before = structuredClone(row);
  const cards = select([row, product({ id: 2, sku: 'NOT-CONFIGURED' })]);
  assert.equal(cards.length, 1);
  assert.deepEqual(Object.keys(cards[0]).sort(), ['availability', 'category', 'id', 'imageUrl', 'name',
    'requestQuoteUrl', 'sku', 'summary', 'supplier'].sort());
  assert.deepEqual(Object.keys(cards[0].availability).sort(), ['local', 'observedAt']);
  assert.equal(cards[0].availability.local, 'in_stock');
  assert.doesNotMatch(JSON.stringify(cards), /PRIVATE-|9876\.54|19000|500|discount|price|details|invoice_id|contact_id|quantity/i);
  assert.deepEqual(row, before, 'Selecting public products must not rewrite the source catalogue.');
  const quoteUrl = new URL(cards[0].requestQuoteUrl);
  assert.equal(quoteUrl.origin, 'https://store.thanda.solar');
  assert.equal(quoteUrl.pathname, '/request-quote');
  assert.equal(quoteUrl.searchParams.get('product'), '1');
});

test('hidden and restricted rows fail closed even with sales and editorial summaries', () => {
  const forbidden = [
    product({ details: { hidden: true } }), product({ details: { hidden: 'true' } }),
    ...[null, {}, { allowedEmails: [] }, { allowedEmails: ['buyer@example.test'] }]
      .map(catalogueVisibility => product({ details: { catalogueVisibility } })),
    product({ supplier: 'enertec' }),
  ];
  for (const row of forbidden) {
    assert.deepEqual(select([row], [configured(row.sku, { supplier: row.supplier })]), []);
  }
  assert.deepEqual(select([product()], [], [], { history: [] }), [], 'An empty sales history must not fabricate popular products.');
});

test('confirmed Victron successor families reuse Popular representative selection once', () => {
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
  assert.equal(result[0].id, 2, 'Representative selection follows the existing Popular helper.');
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

test('sales order overrides editorial positions and no more than eight products become public', () => {
  const rows = Array.from({ length: 10 }, (_, index) => product({ id: index + 1, sku: `SKU${index + 1}` }));
  const config = rows.map((row, index) => configured(row.sku, { position: index + 1 })).reverse();
  const history = rows.map((row, index) => sale(row.sku, 20 - index));
  assert.deepEqual(select(rows, config, [], { history }).map(row => row.id), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('a popular LoRa article is public and an unreviewed image remains absent', () => {
  const reviewed = product({ id: 11, supplier: 'lora', sku: 'LORA-RS-HUB', name: 'LoRa RS Hub',
    image_url: 'https://lora.thanda.solar/unreviewed-product-image.png' });
  const unselected = product({ id: 12, supplier: 'lora', sku: 'LORA-RS-SENSOR', name: 'Unselected LoRa sensor' });
  const config = [configured(reviewed.sku, { supplier: 'lora', summary: 'Local wireless monitoring advice.' })];
  const result = select([reviewed, unselected], config);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 11);
  assert.equal(result[0].supplier, 'lora');
  assert.equal(result[0].imageUrl, null);
  assert.deepEqual(select([reviewed, unselected]), [], 'A supplier without matching sales must not fabricate popular products.');
});

test('Popular changes with signed sales quantities and ignores curated candidates without sales', () => {
  const rows = [product(), product({ id: 2, sku: 'SECOND' }), product({ id: 3, sku: 'BAM030712000' })];
  const config = [configured('BAM030712000'), configured('SECOND', { position: 2 })];
  const history = [sale(rows[0].sku, 12), sale(rows[1].sku, 8)];
  assert.deepEqual(select(rows, config, [], { history }).map(row => row.id), [1, 2]);
  history.push(sale(rows[0].sku, -7, 'credit-first'));
  const cards = select(rows, config, [], { history });
  assert.deepEqual(cards.map(row => row.id), [2, 1]);
  assert.deepEqual(cards.map(row => row.id), rankedFavouriteProducts(history, rows, [], false, now, 8).map(row => row.id));
  assert.equal(cards[1].summary, 'Ask the Thanda team for product advice, availability and a quote.');
  assert.doesNotMatch(JSON.stringify(cards), /PRIVATE-|description|invoice_id|quantity|contact_id/);
});

test('hidden, restricted and non-storefront best sellers are removed before the eight-card limit', () => {
  const blocked = [product({ id: 91, sku: 'HIDDEN', details: { hidden: true } }),
    product({ id: 92, sku: 'PREVIEW', supplier: 'enertec' }),
    product({ id: 93, sku: 'RESTRICTED', details: { catalogueVisibility: null } }),
    product({ id: 94, sku: 'OUTSIDE-RANGE', supplier: 'renogy', category: 'Inverter' }),
    product({ id: 95, sku: 'REMOVED', details: { cataloguePresent: false } })];
  const rows = [...blocked, ...Array.from({ length: 9 }, (_, index) => product({ id: index + 1, sku: `PUBLIC${index + 1}` }))];
  const history = rows.map((row, index) => sale(row.sku, 100 - index));
  assert.deepEqual(select(rows, [], [], { history }).map(row => row.id), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('predecessor and R packaging sales contribute to the existing Popular family ranking', () => {
  const successions = [{ supplier: 'victron', predecessor_sku: 'PMP482305010', successor_sku: 'PMP482305012' }];
  const rows = [product(), product({ id: 2, sku: 'UNRELATED' })];
  const history = [sale('PMP482305010', 6), sale('PMP482305012R', 5), sale('UNRELATED', 9)];
  const config = [configured('PMP482305010', { summary: 'Reviewed family summary.' })];
  const result = select(rows, config, successions, { history });
  assert.deepEqual(result.map(row => row.id), [1, 2]);
  assert.equal(result[0].summary, 'Reviewed family summary.');
});

test('public and authenticated Popular use the same existing calendar-year cutoff', () => {
  assert.equal(favouritesWindowStart(now), '2025-10-24');
  assert.equal(favouritesWindowStart(Date.parse('2024-02-29T23:30:00Z')), '2023-03-01');
});

test('unknown raw supplier stock cannot beat the stocked retail alias used by Popular', () => {
  const ordinary = product({ id: 1, sku: 'BPC121532024', stock_on_hand: 10, details: {
    xeroStockStatus: 'tracked', xeroStockSyncedAt: observedAt, localStockOnHand: 0,
    supplierObservedAt: observedAt, supplierStockStatus: 'unknown' } });
  const retail = product({ id: 2, sku: 'BPC121532024R', stock_on_hand: 0, details: {
    xeroStockStatus: 'tracked', xeroStockSyncedAt: observedAt, localStockOnHand: 1 } });
  const result = select([ordinary, retail], [], [], { history: [sale(ordinary.sku, 3)] });
  assert.deepEqual(result.map(row => row.id), [2]);
  assert.equal(result[0].availability.local, 'in_stock');
});

test('excluded products still prevent ambiguous cross-brand sales from ranking a public product', () => {
  const ordinary = product({ sku: 'BPC121532024' });
  for (const excluded of [
    product({ id: 2, supplier: 'renogy', sku: ordinary.sku, category: 'Inverters' }),
    product({ id: 3, supplier: 'enertec', sku: ordinary.sku }),
    product({ id: 4, supplier: 'renogy', sku: `${ordinary.sku}R`, details: { catalogueVisibility: null } }),
  ]) {
    const history = [sale(excluded.sku, 10)];
    assert.deepEqual(select([ordinary, excluded], [], [], { history }), []);
  }
});
