import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseFulfilmentProduct, familyMemberSkus, loadSkuSuccessions, normalizeSku, productHasStock,
  replacementContext, skuFamilyResolver, successorSkus } from '../src/lib/sku-successions.mjs';
import { rankedFavouriteProducts } from '../src/lib/favourite-products.mjs';

const oldRenogy = 'RBT12100LFP-M-G1-SA';
const newRenogy = 'RBT12100LFP-M-G2-SA';
const successions = [
  { supplier: 'victron', predecessor_sku: 'PMP482305010', successor_sku: 'PMP482305012' },
  { supplier: 'renogy', predecessor_sku: oldRenogy, successor_sku: newRenogy },
];
const observedAt = '2026-10-19T09:20:00Z';
const product = (id, supplier, sku, stock, details = {}) => ({ id, supplier, sku, stock_on_hand: stock,
  price: id * 100, details: { supplierObservedAt: observedAt, ...details } });

test('supplier families reuse Victron packaging aliases without changing other brands', () => {
  const familyFor = skuFamilyResolver(successions);
  assert.equal(familyFor('victron', 'PMP482305010'), familyFor('victron', 'PMP482305012R'));
  assert.equal(familyFor('renogy', oldRenogy), familyFor('renogy', newRenogy));
  assert.notEqual(familyFor('renogy', 'PMP482305010'), familyFor('victron', 'PMP482305010'));
  assert.notEqual(familyFor('renogy', `${newRenogy}R`), familyFor('renogy', newRenogy));
  assert.equal(normalizeSku('renogy', ' sku-r '), 'SKU-R');
  assert.equal(normalizeSku('victron', ' pmp482305012r '), 'PMP482305012');
  assert.deepEqual(familyMemberSkus(successions, 'renogy', newRenogy), [oldRenogy, newRenogy]);
  assert.deepEqual(replacementContext(successions, 'renogy', oldRenogy), { replaces: [], replacedBy: [newRenogy] });
  assert.deepEqual(replacementContext(successions, 'victron', 'PMP482305012R'), { replaces: ['PMP482305010'], replacedBy: [] });
  assert.deepEqual(replacementContext(successions, 'renogy', `${oldRenogy}R`), { replaces: [], replacedBy: [] });
});

test('old unobserved Renogy quantity never becomes stock for a current out-of-stock replacement', () => {
  const old = product(1, 'renogy', oldRenogy, 16, { supplierObservedAt: null });
  const current = product(2, 'renogy', newRenogy, 0);
  const before = structuredClone([old, current]);
  assert.equal(productHasStock(old), false);
  const selected = chooseFulfilmentProduct(old, [old, current], successions);
  assert.equal(selected, current);
  assert.equal(productHasStock(selected), false);
  assert.deepEqual([old, current], before, 'selection must not copy stock or prices between article codes');
});

test('reliably stocked predecessors fulfil under their original SKU and price', () => {
  for (const supplier of ['renogy', 'victron']) {
    const relation = successions.find((row) => row.supplier === supplier);
    const old = product(1, supplier, relation.predecessor_sku, 3);
    const current = product(2, supplier, relation.successor_sku, 8);
    assert.equal(chooseFulfilmentProduct(current, [old, current], successions), old);
    old.details.supplierObservedAt = null;
    old.details.localStockOnHand = 2;
    old.details.xeroStockStatus = 'tracked';
    old.details.xeroStockSyncedAt = observedAt;
    assert.equal(chooseFulfilmentProduct(current, [old, current], successions), old);
  }
});

test('fulfilment cannot use another supplier or treat a literal Renogy R suffix as packaging', () => {
  const old = product(1, 'renogy', oldRenogy, 0);
  const current = product(2, 'renogy', newRenogy, 0);
  const otherBrand = product(3, 'victron', oldRenogy, 40);
  const otherCode = product(4, 'renogy', `${oldRenogy}R`, 50);
  assert.equal(chooseFulfilmentProduct(old, [otherBrand, otherCode, current, old], successions), current);
});

test('successors follow directed chains newest first and cycles terminate', () => {
  const chain = [...successions, { supplier: 'renogy', predecessor_sku: newRenogy, successor_sku: 'RENOGY-G3' }];
  assert.deepEqual(successorSkus(chain, 'renogy', oldRenogy), ['RENOGY-G3', newRenogy]);
  const old = product(1, 'renogy', oldRenogy, 0);
  const current = product(2, 'renogy', newRenogy, 0);
  const newest = product(3, 'renogy', 'RENOGY-G3', 0);
  assert.equal(chooseFulfilmentProduct(old, [old, current, newest], chain), newest);
  const cyclic = [...chain, { supplier: 'renogy', predecessor_sku: 'RENOGY-G3', successor_sku: oldRenogy }];
  assert.deepEqual(successorSkus(cyclic, 'renogy', oldRenogy), ['RENOGY-G3', newRenogy]);
  assert.equal(chooseFulfilmentProduct(old, [old, current, newest], cyclic), old);
});

test('a missing supplier table does not discard the other canonical relationships', async () => {
  for (const missing of ['renogy', 'victron']) {
    const calls = [];
    const rows = await loadSkuSuccessions({ query: async (sql) => {
      calls.push(sql);
      if (sql.includes(`FROM ${missing}_sku_successions`)) throw Object.assign(new Error('not yet provisioned'), { code: '42P01' });
      return { rows: [{ predecessor_sku: 'OLD', successor_sku: 'NEW' }] };
    } });
    assert.equal(calls.length, 2);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].supplier, missing === 'renogy' ? 'victron' : 'renogy');
  }
  await assert.rejects(loadSkuSuccessions({ query: async () => { throw Object.assign(new Error('database unavailable'), { code: '08006' }); } }), /unavailable/);
});

const invoice = (sku, quantity, invoice_id = sku) => ({ sku, quantity, invoice_id, invoice_date: observedAt });
const catalogueProduct = (supplier, sku, stock = 0) => ({ supplier, sku, stock_on_hand: stock, details: { localStockOnHand: null } });

test('historic PMP482305010 sales contribute to current PMP482305012 Home demand', () => {
  const current = catalogueProduct('victron', 'PMP482305012', 8);
  const unrelated = catalogueProduct('victron', 'UNRELATED', 2);
  const ranked = rankedFavouriteProducts([
    invoice('PMP482305010', 3), invoice('PMP482305012R', 2), invoice('UNRELATED', 4),
  ], [unrelated, current], successions, false, Date.parse(observedAt));
  assert.deepEqual(ranked, [current, unrelated]);
});

test('Renogy historical purchases select the current card without copying old stock', () => {
  const current = catalogueProduct('renogy', newRenogy, 0);
  const unrelated = catalogueProduct('renogy', 'OTHER', 2);
  const ranked = rankedFavouriteProducts([
    invoice(oldRenogy, 3), invoice(newRenogy, 2), invoice('OTHER', 4),
  ], [current, unrelated], successions, false, Date.parse(observedAt));
  assert.deepEqual(ranked, [current, unrelated]);
  assert.equal(ranked[0].stock_on_hand, 0);
});

test('Home uses a stocked predecessor while the replacement has zero stock', () => {
  const old = catalogueProduct('renogy', oldRenogy, 2);
  const current = catalogueProduct('renogy', newRenogy, 0);
  assert.deepEqual(rankedFavouriteProducts([invoice(oldRenogy, 1)], [current, old], successions, true), [old]);
  assert.deepEqual(rankedFavouriteProducts([invoice(oldRenogy, 1)], [catalogueProduct('renogy', oldRenogy)], successions, true), []);
});

test('Home accepts a current terminal replacement when a retired intermediate was never imported', () => {
  const chain = [...successions, { supplier: 'renogy', predecessor_sku: newRenogy, successor_sku: 'RENOGY-G3' }];
  const terminal = catalogueProduct('renogy', 'RENOGY-G3', 0);
  assert.deepEqual(rankedFavouriteProducts([invoice(oldRenogy, 1)], [terminal], chain, true), [terminal]);
  assert.deepEqual(rankedFavouriteProducts([invoice(oldRenogy, 1)], [catalogueProduct('renogy', newRenogy)], chain, true), []);
});

test('hidden rows are excluded consistently whether the stored JSON value is boolean or text', () => {
  const old = product(1, 'renogy', oldRenogy, 3);
  const current = product(2, 'renogy', newRenogy, 0);
  for (const hidden of [true, 'true']) {
    const hiddenOld = { ...old, details: { ...old.details, hidden } };
    assert.equal(chooseFulfilmentProduct(current, [hiddenOld, current], successions), current);
    assert.equal(chooseFulfilmentProduct(hiddenOld, [hiddenOld, current], successions), null);
  }
});

test('Home never merges an unrelated Renogy R article or attributes an ambiguous cross-brand invoice', () => {
  const current = catalogueProduct('renogy', newRenogy);
  const separate = catalogueProduct('renogy', `${oldRenogy}R`);
  assert.deepEqual(rankedFavouriteProducts([invoice(`${oldRenogy}R`, 5), invoice(oldRenogy, 1)], [current, separate], successions, false), [separate, current]);
  const collision = catalogueProduct('victron', oldRenogy);
  assert.deepEqual(rankedFavouriteProducts([invoice(oldRenogy, 8)], [current, collision], successions, false), []);
});
