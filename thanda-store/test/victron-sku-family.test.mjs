import assert from 'node:assert/strict';
import test from 'node:test';
import { familyMemberSkus, predecessorSkusForFamily, victronSkuFamilyResolver } from '../src/lib/victron-sku-family.mjs';

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
