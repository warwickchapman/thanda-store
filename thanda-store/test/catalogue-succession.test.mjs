import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogueProductMatchesQuery, isSupersededForDiscovery, withSuccessionDetails } from '../src/lib/catalogue-succession.mjs';
import { productDetails } from '../src/lib/product-details.mjs';

const oldSku = 'RBT12100LFP-M-G1-SA';
const newSku = 'RBT12100LFP-M-G2-SA';
const successions = [{ supplier: 'renogy', predecessor_sku: oldSku, successor_sku: newSku }];
const old = { supplier: 'renogy', sku: oldSku, name: 'Core Mini battery', stock_on_hand: 16, details: {} };
const current = { ...old, sku: newSku, stock_on_hand: 0, details: { supplierObservedAt: '2026-10-19T09:20:00Z', supplierStockStatus: 'known' } };

test('an explicit replacement removes the unknown legacy card without changing either SKU stock', () => {
  assert.equal(isSupersededForDiscovery(old, [old, current], successions), true);
  assert.equal(isSupersededForDiscovery(current, [old, current], successions), false);
  assert.equal(old.stock_on_hand, 16);
  assert.equal(current.stock_on_hand, 0);
  assert.equal(isSupersededForDiscovery(old, [old], successions), false, 'missing replacement cannot remove the only card');
  assert.equal(isSupersededForDiscovery(old, [old, current], []), false, 'G-number similarity is not replacement evidence');
});

test('observed positive supplier or Thanda stock keeps the predecessor saleable; unknown is not positive', () => {
  for (const details of [
    { supplierObservedAt: '2026-10-19T09:20:00Z', supplierStockStatus: 'known' },
    { localStockOnHand: 2, xeroStockStatus: 'tracked', xeroStockSyncedAt: '2026-10-19T09:20:00Z' },
  ]) assert.equal(isSupersededForDiscovery({ ...old, details }, [old, current], successions), false);
  assert.equal(isSupersededForDiscovery({ ...old, details: { localStockOnHand: 2, xeroStockStatus: 'missing' } }, [old, current], successions), true);
});

test('replacement labels and old-SKU search lead to the current article with its own description', () => {
  const card = withSuccessionDetails(current, successions);
  assert.equal(catalogueProductMatchesQuery(card, oldSku.toLowerCase()), true);
  assert.equal(catalogueProductMatchesQuery(card, 'no match'), false);
  assert.deepEqual(card.details.replaces, [oldSku]);
  assert.deepEqual(productDetails(card).replaces, [oldSku]);
  assert.equal(productDetails(card).description, current.name);
  assert.deepEqual(productDetails(withSuccessionDetails(old, successions)).replacedBy, [newSku]);
});

test('discovery replacements stay isolated by supplier', () => {
  assert.equal(isSupersededForDiscovery(old, [old, { ...current, supplier: 'victron' }], successions), false);
  assert.deepEqual(withSuccessionDetails({ ...current, supplier: 'victron' }, successions).details.replaces, []);
});

test('searching the oldest code finds the terminal successor after more than one replacement', () => {
  const latest = { ...current, sku: 'RBT12100LFP-M-G3-SA' };
  const chain = [...successions, { supplier: 'renogy', predecessor_sku: newSku, successor_sku: latest.sku }];
  const card = withSuccessionDetails(latest, chain);
  assert.equal(catalogueProductMatchesQuery(card, oldSku), true);
  assert.deepEqual(card.details.replaces, [newSku], 'labels retain the direct replacement relationship');
});
