import test from 'node:test';
import assert from 'node:assert/strict';
import { observeRenogyStock } from '../src/lib/renogy-stock.mjs';
import { supplierStockObservation } from '../src/lib/data-freshness.mjs';

const observedAt = '2026-10-22T07:07:00.000Z';
const exportAt = '2026-10-22T07:06:00.000Z';
const row = { Stock: '28', source: 'renogy-export', stockObservedAt: exportAt };

test('G2 portal availability28 overrides the unrelated raw inventory0', () => {
  assert.deepEqual(observeRenogyStock({ availble: 28, inventory: 0, safety_inventory: 28, available_overseas: 28 }, row, observedAt), {
    quantity: 28, observedAt, source: 'renogy-detail.availble',
  });
});

test('confirmed portal zero is retained despite positive fallback quantities and backorders', () => {
  assert.deepEqual(observeRenogyStock({ availble: 0, inventory: 99, safety_remaining: 100 }, row, observedAt), {
    quantity: 0, observedAt, source: 'renogy-detail.availble',
  });
  assert.equal(observeRenogyStock({ availble: '0' }, row, observedAt).quantity, 0);
});

test('missing or invalid portal quantity uses export Available with its own observation time', () => {
  for (const value of [undefined, null, '', ' ', true, false, [], {}, NaN, Infinity, -1, '-1', 1.5, '1.5', '1,000', '0x10', '1e3']) {
    assert.deepEqual(observeRenogyStock({ availble: value, inventory: 0 }, row, observedAt), {
      quantity: 28, observedAt: exportAt, source: 'renogy-export.Available',
    });
  }
  assert.equal(observeRenogyStock({}, { ...row, Stock: '0' }, observedAt).quantity, 0);
  assert.equal(observeRenogyStock({ availble: ' 28.00 ' }, row, observedAt).quantity, 28);
});

test('warehouse totals and backorder capacity cannot substitute for missing availability', () => {
  const stock = observeRenogyStock({ inventory: 28, available_overseas: 28, safety_inventory: 28, safety_remaining: 28 }, {}, observedAt);
  assert.deepEqual(stock, { quantity: null, observedAt: null, source: null });
  assert.equal(supplierStockObservation({ supplier: 'renogy', stock_on_hand: 0, details: { supplierObservedAt: stock.observedAt, supplierStockStatus: 'unknown' } }).quantity, null);
});

test('reading a CSV or an export without an observation does not manufacture fresh stock', () => {
  for (const sourceRow of [{ ...row, source: 'warehouse-csv' }, { ...row, stockObservedAt: undefined }]) {
    const stock = observeRenogyStock({}, sourceRow, observedAt);
    assert.equal(stock.quantity, 28);
    assert.equal(stock.observedAt, null);
    assert.equal(supplierStockObservation({ supplier: 'renogy', stock_on_hand: stock.quantity, details: { supplierObservedAt: stock.observedAt } }).quantity, null);
  }
  assert.equal(observeRenogyStock({}, { ...row, source: 'unverified-source' }, observedAt).quantity, null);
});
