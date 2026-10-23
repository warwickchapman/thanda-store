import assert from 'node:assert/strict';
import test from 'node:test';
import { familyMemberSkus, predecessorSkusForFamily, victronSkuFamilyResolver, successorSkuFromDescription,
  skuReplacementContext, victronArticleSuccessions } from '../src/lib/victron-sku-family.mjs';

test('PMP482305010 sales resolve into the PMP482305012 replacement family', () => {
  const successions = [{ predecessor_sku: 'PMP482305010', successor_sku: 'PMP482305012' }];
  const familyFor = victronSkuFamilyResolver(successions);
  const sales = [
    { sku: 'PMP482305010', quantity: 3 },
    { sku: 'PMP482305012', quantity: 2 },
  ];
  const salesByFamily = new Map();
  for (const sale of sales) {
    const family = familyFor(sale.sku);
    salesByFamily.set(family, (salesByFamily.get(family) || 0) + sale.quantity);
  }
  assert.equal(familyFor('PMP482305012'), familyFor('PMP482305010'));
  assert.equal(salesByFamily.get(familyFor('PMP482305012')), 5);
  assert.deepEqual(predecessorSkusForFamily(successions, familyFor('PMP482305012')), ['PMP482305010']);
  assert.deepEqual(familyMemberSkus(successions, 'PMP482305012'), ['PMP482305010', 'PMP482305012']);
});

test('predecessor Xero stock contributes to the current SKU family', () => {
  const successions = [{ predecessor_sku: 'ASS030064900', successor_sku: 'ASS030064901' }];
  const familyFor = victronSkuFamilyResolver(successions);
  const stockByFamily = new Map();
  for (const row of [
    { sku: 'ASS030064900', quantity: 24 },
    { sku: 'ASS030064901', quantity: 0 },
  ]) {
    const family = familyFor(row.sku);
    stockByFamily.set(family, (stockByFamily.get(family) || 0) + row.quantity);
  }

  assert.equal(
    stockByFamily.get(familyFor('ASS030064901')),
    24,
  );
});

test('free-form Cerbo product-name advice cannot merge, label or suppress separate inventory articles', () => {
  const bad = [{ predecessor_sku: 'BPP900400100', successor_sku: 'CERBO' },
    { predecessor_sku: 'BPP900450100', successor_sku: 'CERBO' }];
  const familyFor = victronSkuFamilyResolver(bad);
  assert.notEqual(familyFor('BPP900400100'), familyFor('BPP900450100'));
  assert.deepEqual(victronArticleSuccessions(bad), []);
  assert.deepEqual(skuReplacementContext(bad, 'BPP900400100'), { replaces: [], replacedBy: [] });
  assert.deepEqual(familyMemberSkus(bad, 'BPP900400100'), ['BPP900400100']);
  assert.equal(successorSkuFromDescription('Venus GX *If 0, order Cerbo GX MK2*'), null);
  assert.equal(successorSkuFromDescription('MultiPlus *If 0, order PMP482305012*'), 'PMP482305012');
});
