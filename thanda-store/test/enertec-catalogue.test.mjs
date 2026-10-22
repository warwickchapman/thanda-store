import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnertecProducts, enertecGrossMargin, saveEnertecProducts, summarizeEnertecProducts } from '../src/lib/enertec-catalogue.mjs';
import { isProductVisibleTo } from '../src/lib/catalogue-access.mjs';
import { supplierStockObservation, localStockObservation } from '../src/lib/data-freshness.mjs';
import { productDetails, publicManufacturerUrl } from '../src/lib/product-details.mjs';

// Invented fixtures verify behavior without reading the supplier's private data.
const originalPreviewEmails = process.env.ENERTEC_PREVIEW_EMAILS;
process.env.ENERTEC_PREVIEW_EMAILS = 'preview.one@example.test,preview.two@example.test';
after(() => {
  if (originalPreviewEmails === undefined) delete process.env.ENERTEC_PREVIEW_EMAILS;
  else process.env.ENERTEC_PREVIEW_EMAILS = originalPreviewEmails;
});
const fixture = (sku, list, overrides = {}) => ({
  sku, list, brand: 'Fixture brand', name: 'Synthetic test battery',
  sourceRanges: ['Synthetic source range'], costExVat: 77, grossMarginPercent: 23,
  discontinued: false, specificationsNeedReview: false, priceOnRequest: false,
  source: { document: 'synthetic-fixture.pdf', pages: [1], priceListCode: 'fixture' },
  imageUrl: '', resources: [], ...overrides,
});
const entries = [
  fixture('TEST-BATTERY-001', 'energizer', {
    imageUrl: 'https://enertec.co.za/synthetic-fixtures/test-battery.jpg',
    resources: [
      { kind: 'product', title: 'Synthetic product', url: 'https://enertec.co.za/products/synthetic-test-battery.html' },
      { kind: 'datasheet', title: 'Synthetic datasheet', url: 'https://enertec.co.za/synthetic-fixtures/test-battery.pdf' },
    ],
  }),
  fixture('TEST-BATTERY-002', 'marine', { costExVat: 264, grossMarginPercent: 12, discontinued: true }),
  fixture('TEST-CHARGER-001', 'ctek', { name: 'Synthetic bench charger', costExVat: null }),
  fixture('TEST-CHARGER-002', 'ctek', { name: 'Synthetic charger', costExVat: 13.37, grossMarginPercent: 0 }),
  fixture('TEST-ACCESSORY-001', 'marine', { name: 'Synthetic accessory', priceOnRequest: true, specificationsNeedReview: true }),
];
const products = buildEnertecProducts(entries);

test('synthetic preview retains the three ranges, lifecycle flags, restricted access and unknown stock', () => {
  assert.deepEqual(summarizeEnertecProducts(products), {
    total: 5, previewVisible: 4, hiddenDiscontinued: 1, priceOnRequest: 2,
    categories: { Energizer: 1, 'Marine & Leisure': 1, CTEK: 2 },
    accounts: ['preview.one@example.test', 'preview.two@example.test'],
  });
  assert.equal(new Set(products.map(product => product.sku)).size, products.length);
  for (const product of products) {
    assert.equal(product.supplier, 'enertec');
    assert.equal(product.details.catalogueClassification.category, product.category);
    assert.equal(supplierStockObservation(product).quantity, null);
    assert.equal(localStockObservation(product).quantity, null);
    assert.equal(isProductVisibleTo(product, 'preview.one@example.test'), true);
    assert.equal(isProductVisibleTo(product, 'preview.two@example.test'), true);
    assert.equal(isProductVisibleTo(product, 'another.admin@example.test'), false);
    assert.equal(isProductVisibleTo(product, undefined), false);
    assert.equal(Object.hasOwn(product.details, 'catalogueVisibility'), false);
  }
  assert.equal(products[1].details.hidden, true);
});

test('selling prices use the supplied gross margin and expose fixed customer prices separately from source cost', () => {
  assert.equal(products[0].price, 100);
  assert.equal(products[0].details.supplierCostExVat, entries[0].costExVat);
  assert.equal(products[1].price, 300);
  assert.equal(products[3].price, 13.37);
  for (const product of products.filter(product => product.details.pricingStatus !== 'unpriced')) {
    assert.equal(product.details.fixedDealerPrice, true);
    assert.equal(product.details.recommendedRetailExVat, product.price);
    assert.ok(product.price >= product.details.supplierCostExVat);
  }
  assert.equal(enertecGrossMargin({ grossMarginPercent: 0 }), 0);
  assert.equal(enertecGrossMargin({ grossMarginPercent: 99.5 }), 99.5);
});

test('missing buying prices and explicit price holds remain price on request', () => {
  for (const product of [products[2], products[4]]) {
    assert.equal(product.price, 0);
    assert.equal(product.details.pricingStatus, 'unpriced');
    assert.equal(product.details.recommendedRetailExVat, null);
    assert.equal(product.details.enertecGrossMarginPercent, null);
    assert.equal(product.details.hidden, false);
  }
  assert.ok(products[4].details.productNotes.some(note => note.includes('supplier confirmation')));
});

test('seed input rejects duplicate identities, malformed source metadata, costs and margins', () => {
  for (const changed of [
    [], null, [...entries, entries[0]], [{ ...entries[0], costExVat: -1 }],
    [{ ...entries[0], costExVat: '77' }], [{ ...entries[0], costExVat: NaN }],
    [{ ...entries[0], list: 'unknown' }], [{ ...entries[0], sku: '../invalid sku' }],
    [{ ...entries[0], name: '' }], [{ ...entries[0], sourceRanges: [] }],
    [{ ...entries[0], discontinued: 'false' }],
  ]) assert.throws(() => buildEnertecProducts(changed));
  for (const grossMarginPercent of [undefined, null, -1, 100, Infinity, NaN, '23']) {
    assert.throws(() => enertecGrossMargin({ grossMarginPercent }));
    assert.throws(() => buildEnertecProducts([{ ...entries[0], grossMarginPercent }]));
  }
});

test('synthetic media stays remote and public product details omit buying metadata', () => {
  assert.equal(products[0].image_url, entries[0].imageUrl);
  const details = productDetails(products[0]);
  assert.equal(details.links.length, 2);
  for (const product of products) {
    const publicDetails = productDetails(product);
    assert.equal(Object.hasOwn(publicDetails, 'supplierCostExVat'), false);
    assert.equal(Object.hasOwn(publicDetails, 'enertecSource'), false);
    assert.equal(JSON.stringify(publicDetails).includes('synthetic-fixture.pdf'), false);
  }
  const rejected = productDetails({ ...products[0], details: { ...products[0].details,
    publicResources: [{ kind: 'datasheet', title: 'Untrusted', url: 'https://private.example.test/document.pdf' }],
  } });
  assert.deepEqual(rejected.links, []);
  assert.equal(publicManufacturerUrl('https://enertec.co.za.attacker.test/sheet.pdf', 'enertec'), null);
  assert.equal(publicManufacturerUrl('http://enertec.co.za/sheet.pdf', 'enertec'), null);
  assert.equal(publicManufacturerUrl('https://enertec.co.za@attacker.test/sheet.pdf', 'enertec'), null);
  assert.equal(publicManufacturerUrl('https://enertec.co.za/sheet.pdf', 'renogy'), null);
});

test('seed is atomic, parameterized, preserves operational fields and rolls back failures', async () => {
  const calls = [];
  const db = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; } };
  await saveEnertecProducts(db, [products[0]]);
  assert.equal(calls[0].sql, 'BEGIN');
  assert.equal(calls.at(-1).sql, 'COMMIT');
  const insert = calls.find(call => call.sql.startsWith('INSERT'));
  const update = insert.sql.split('DO UPDATE SET')[1];
  assert.ok(!update.includes('stock_on_hand='));
  assert.match(update, /- 'localStockOnHand'/);
  assert.match(update, /- 'supplierStockStatus'/);
  assert.match(update, /- 'hidden'/);
  assert.ok(!insert.sql.includes(products[0].sku));
  assert.equal(insert.values[0], products[0].supplier_item_id);
  assert.equal(insert.values[1], products[0].sku);
  assert.equal(insert.values[4], products[0].price);
  assert.equal(JSON.parse(insert.values[6]).supplierCostExVat, entries[0].costExVat);
  const failedCalls = [];
  const broken = { query: async sql => {
    failedCalls.push(sql);
    if (sql.startsWith('INSERT')) throw new Error('synthetic write failure');
  } };
  await assert.rejects(saveEnertecProducts(broken, [products[0]]), /synthetic write failure/);
  assert.equal(failedCalls.at(-1), 'ROLLBACK');
  assert.ok(!failedCalls.includes('COMMIT'));
});
