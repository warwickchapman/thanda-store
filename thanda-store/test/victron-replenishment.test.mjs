import assert from 'node:assert/strict';
import test from 'node:test';
import { victronSkuFamilyResolver } from '../src/lib/victron-sku-family.mjs';
import { loadInventoryScope } from '../src/lib/inventory-scope.mjs';
import {
  replenishmentFamilyStocks,
  replenishmentRecommendation,
  replenishmentSourceKnown,
} from '../src/lib/victron-replenishment.mjs';

const checkedAt = '2026-09-27T12:00:00.000Z';
const observedAt = '2026-09-27T11:30:00.000Z';
const options = { checkedAt, staleAfterMinutes: 120 };
const successions = [{ predecessor_sku: 'PMP482305010', successor_sku: 'PMP482305012' }];
const product = (sku, quantity, details = {}) => ({ sku, supplier: 'victron', details: {
  xeroStockStatus: 'tracked', xeroStockSyncedAt: observedAt, localStockOnHand: quantity, ...details,
} });
const inventoryEvidence = ({ products, items, requirements = [], previouslyTracked = {} }) => loadInventoryScope({
  query: async sql => ({ rows: sql.includes('FROM thanda_inventory_evidence') ? [{
    company: 'thanda-solar', observed_at: observedAt, snapshot: 'complete-items', items,
    previously_tracked: previouslyTracked, known_victron_codes: [],
  }] : requirements }),
}, { products, successions, now: checkedAt, runs: ['thanda', 'sales', 'victron-orders', 'accepted-quotes'].map(source_id => ({
  source_id, last_status: 'success', source_observed_at: observedAt, last_successful_at: observedAt,
})) });
const planning = {
  sales30: 30, sales90: 45, localStock: 3, inbound: 2,
  backorderCoverage: 1, reserved: 1, provisional: 2, minimumStock: 0,
};

test('PMP482305010 historic demand and hidden stock contribute to PMP482305012 planning', () => {
  const familyFor = victronSkuFamilyResolver(successions);
  const stock = replenishmentFamilyStocks([
    product('PMP482305010', 5, { hidden: true }),
    product('PMP482305012', 2),
  ], successions, options).get(familyFor('PMP482305012'));
  const sales = [
    { sku: 'PMP482305010', sales30: 20, sales90: 50 },
    { sku: 'PMP482305012', sales30: 10, sales90: 40 },
  ].filter(row => familyFor(row.sku) === familyFor('PMP482305012'));
  const recommendation = replenishmentRecommendation({
    ...planning,
    sales30: sales.reduce((sum, row) => sum + row.sales30, 0),
    sales90: sales.reduce((sum, row) => sum + row.sales90, 0),
    localStock: stock.localStock,
  });
  assert.equal(stock.localStock, 7);
  assert.equal(recommendation.dailyDemand, 1);
  assert.equal(recommendation.suggestedOrder, 3);
  assert.deepEqual(stock.missingSkus, []);
});

test('unknown hidden predecessor withholds a total and suggestion instead of counting zero', () => {
  const stock = replenishmentFamilyStocks([
    product('PMP482305010', 0, { hidden: true, xeroStockStatus: 'missing' }),
    product('PMP482305012', 2),
  ], successions, options).get('PMP482305010');
  assert.equal(stock.localStock, null);
  assert.equal(stock.knownStock, 2);
  assert.deepEqual(stock.missingSkus, ['PMP482305010']);
  assert.equal(replenishmentRecommendation({ ...planning, localStock: stock.localStock }).suggestedOrder, null);
});

test('a mapped predecessor absent from the catalogue is still an unknown contributor', () => {
  const stock = replenishmentFamilyStocks([product('PMP482305012', 2)], successions, options).get('PMP482305010');
  assert.equal(stock.localStock, null);
  assert.deepEqual(stock.missingSkus, ['PMP482305010']);
});

test('shared catalogue-only successor policy preserves known predecessor stock and inherited demand', async () => {
  const products = [
    product('PMP482305010', 5, { hidden: true }),
    product('PMP482305012', null, { xeroStockStatus: 'missing' }),
  ];
  const scope = await inventoryEvidence({ products, items: [{ Code: 'PMP482305010', ItemID: 'old-item',
    Name: 'Victron MultiPlus', IsTrackedAsInventory: true, QuantityOnHand: 5 }],
    requirements: [{ sku: 'PMP482305010', signal: 'Recorded sales or credit activity' }] });
  assert.equal(scope.complete, true);
  assert.equal(scope.articles.get('PMP482305012').kind, 'catalogue');
  const familyFor = victronSkuFamilyResolver(successions);
  const stock = replenishmentFamilyStocks(scope.stockProducts, successions,
    { ...options, inventoryScope: scope.articles }).get(familyFor('PMP482305012'));
  assert.equal(stock.localStock, 5);
  assert.deepEqual(stock.missingSkus, []);
  assert.deepEqual(stock.catalogueOnlySkus, ['PMP482305012']);
  const recommendation = replenishmentRecommendation({ ...planning, localStock: stock.localStock,
    // Historic demand remains in the replacement family; omitting a never
    // stocked successor from physical stock must not erase that demand.
    sales30: 30, sales90: 45 });
  assert.equal(recommendation.dailyDemand, 1);
  assert.equal(recommendation.suggestedOrder, 5);
});

test('shared required hidden predecessor policy withholds family stock when successor is known', async () => {
  const products = [
    product('PMP482305010', null, { hidden: true, xeroStockStatus: 'missing' }),
    product('PMP482305012', 2),
  ];
  const scope = await inventoryEvidence({ products, items: [{ Code: 'PMP482305012', ItemID: 'new-item',
    Name: 'Victron MultiPlus', IsTrackedAsInventory: true, QuantityOnHand: 2 }],
    previouslyTracked: { PMP482305010: observedAt },
    requirements: [{ sku: 'PMP482305010', signal: 'Recorded sales or credit activity' }] });
  assert.equal(scope.articles.get('PMP482305010').kind, 'required');
  const stock = replenishmentFamilyStocks(scope.stockProducts, successions,
    { ...options, inventoryScope: scope.articles }).get('PMP482305010');
  assert.equal(stock.localStock, null);
  assert.equal(stock.knownStock, 2);
  assert.deepEqual(stock.missingSkus, ['PMP482305010']);
  assert.deepEqual(stock.catalogueOnlySkus, []);
});

test('unknown and absent scope entries stay required, including obligations absent from products', () => {
  for (const inventoryScope of [new Map(), new Map([['PMP482305010', { kind: 'unknown' }]])]) {
    const stock = replenishmentFamilyStocks([product('PMP482305012', 2)], successions,
      { ...options, inventoryScope }).get('PMP482305010');
    assert.equal(stock.localStock, null);
    assert.deepEqual(stock.missingSkus, ['PMP482305010']);
  }
  const exposed = replenishmentFamilyStocks([], [], { ...options,
    inventoryScope: new Map([['EXPOSED001', { kind: 'required', reasons: ['open delivery'] }]]) }).get('EXPOSED001');
  assert.equal(exposed.localStock, null);
  assert.equal(exposed.knownStock, null);
  assert.deepEqual(exposed.missingSkus, ['EXPOSED001']);
});

test('catalogue-only families stay in the audit without manufacturing physical stock zero', () => {
  const stock = replenishmentFamilyStocks([product('CATALOGUE001', null, { xeroStockStatus: 'missing' })], [],
    { ...options, inventoryScope: new Map([['CATALOGUE001', { kind: 'catalogue' }]]) }).get('CATALOGUE001');
  assert.equal(stock.localStock, null);
  assert.equal(stock.knownStock, null);
  assert.equal(stock.observedAt, null);
  assert.deepEqual(stock.missingSkus, []);
  assert.deepEqual(stock.catalogueOnlySkus, ['CATALOGUE001']);
});

test('base and retail packaging are not counted twice', () => {
  const stock = replenishmentFamilyStocks([
    product('PMP482305010', 2), product('PMP482305010R', 2),
    product('PMP482305012', 5), product('PMP482305012R', 5),
  ], successions, options).get('PMP482305010');
  assert.equal(stock.localStock, 7);
  assert.deepEqual(stock.missingSkus, []);
});

test('a tracked retail observation can supply its base article when only that packaging exists', () => {
  const stock = replenishmentFamilyStocks([product('ASS030064901R', 6)], [], options).get('ASS030064901');
  assert.equal(stock.localStock, 6);
});

test('shared snapshot scope keeps tracked zero and uses retail stock only when base quantity is unusable', async () => {
  for (const [baseQuantity, expected] of [[0, 0], [null, 6]]) {
    const products = [product('ASS030064901', null, { xeroStockStatus: 'missing' }),
      product('ASS030064901R', null, { xeroStockStatus: 'missing' })];
    const scope = await inventoryEvidence({ products, items: [
      { Code: 'ASS030064901', ItemID: 'base-item', Name: 'Victron cable', IsTrackedAsInventory: true, QuantityOnHand: baseQuantity },
      { Code: 'ASS030064901R', ItemID: 'retail-item', Name: 'Victron cable', IsTrackedAsInventory: true, QuantityOnHand: 6 },
    ] });
    const stock = replenishmentFamilyStocks(scope.stockProducts, successions,
      { ...options, inventoryScope: scope.articles }).get('ASS030064901');
    assert.equal(stock.localStock, expected);
    assert.equal(stock.knownStock, expected);
    assert.deepEqual(stock.missingSkus, []);
  }
});

test('confirmed zero stays zero while absent, untracked, invalid and undated quantities stay unknown', () => {
  assert.equal(replenishmentFamilyStocks([product('TEST001', 0)], [], options).get('TEST001').localStock, 0);
  for (const details of [
    { localStockOnHand: null }, { localStockOnHand: '' }, { localStockOnHand: 'not a quantity' },
    { xeroStockStatus: 'untracked' }, { xeroStockSyncedAt: null },
    { xeroStockSyncedAt: '2026-09-28T12:00:00.000Z' },
  ]) {
    assert.equal(replenishmentFamilyStocks([product('TEST001', 0, details)], [], options).get('TEST001').localStock, null);
  }
});

test('overdue predecessor stock remains usable but is explicitly identified for review', () => {
  const stock = replenishmentFamilyStocks([
    product('PMP482305010', 5, { xeroStockSyncedAt: '2026-09-26T11:30:00.000Z' }),
    product('PMP482305012', 2),
  ], successions, options).get('PMP482305010');
  assert.equal(stock.localStock, 7);
  assert.deepEqual(stock.staleSkus, ['PMP482305010']);
  assert.equal(stock.observedAt, '2026-09-26T11:30:00.000Z');
});

test('each unknown required input withholds order quantities and cover', () => {
  for (const input of ['sales30', 'sales90', 'localStock', 'inbound', 'backorderCoverage', 'reserved']) {
    const recommendation = replenishmentRecommendation({ ...planning, [input]: null });
    assert.equal(recommendation.suggestedOrder, null, input);
    assert.equal(recommendation.daysCover, null, input);
    assert.equal(recommendation.status, 'review', input);
  }
});

test('known zero inputs produce a legitimate covered state', () => {
  const recommendation = replenishmentRecommendation({
    sales30: 0, sales90: 0, localStock: 0, inbound: 0,
    backorderCoverage: 0, reserved: 0, provisional: 0, minimumStock: 0,
  });
  assert.equal(recommendation.suggestedOrder, 0);
  assert.equal(recommendation.status, 'covered');
});

test('unobserved credit history cannot be concealed by a known invoice observation', () => {
  assert.equal(replenishmentSourceKnown({ observedAt, totalCount: 2, missingCount: 1 }), false);
  assert.equal(replenishmentSourceKnown({ observedAt, totalCount: 2, missingCount: 0, status: 'stale' }), true);
  assert.equal(replenishmentSourceKnown({ observedAt, totalCount: 2, missingCount: 0, status: 'error' }), true);
  assert.equal(replenishmentSourceKnown({ observedAt: null, totalCount: 2, missingCount: 2 }), false);
  assert.equal(replenishmentSourceKnown(undefined), false);
});
