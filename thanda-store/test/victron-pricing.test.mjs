import assert from 'node:assert/strict';
import test from 'node:test';
import { prices } from '../src/lib/victron-pricing.mjs';

const product = (price = 525, list) => ({ price, currency: 'ZAR', enduser_price_zar: { price: list } });

test('ordinary decimal prices preserve explicit list and use missing-list fallback', () => {
  assert.deepEqual(prices(product(' 525.00 ', '1000.00')), { cost: 525, list: 1000, sensible: 600, listSource: 'eorder' });
  for (const absent of [undefined, null, '', '   ']) {
    assert.deepEqual(prices(product(5245.28, absent)), { cost: 5245.28, list: 9991.01, sensible: 5994.61, listSource: 'calculated' });
  }
  assert.equal(prices(product(5245.28, 1000)).sensible, 600);
  assert.ok(prices({ ...product(), currency: 'EUR' }).error);
});

test('malformed supplier prices cannot be coerced into monetary amounts', () => {
  for (const value of [true, false, [], [525], {}, { valueOf: () => 525 }, '0x20', '5.25e2', 'NaN', NaN, Infinity, 'Infinity', '+525', '-1', 0, '0.00', '1.005', 1.005, '1.000']) {
    assert.ok(prices(product(value)).error, `cost: ${String(value)}`);
    assert.ok(prices(product(525, value)).error, `list: ${String(value)}`);
  }
});

test('explicit and calculated prices use the same exclusive upper bound as Hub', () => {
  assert.deepEqual(prices(product(0.01, null)), { cost: 0.01, list: 0.02, sensible: 0.01, listSource: 'calculated' });
  assert.deepEqual(prices(product(9999999.99, 9999999.99)), { cost: 9999999.99, list: 9999999.99, sensible: 5999999.99, listSource: 'eorder' });
  assert.equal(prices(product(5249999.99, null)).list, 9999999.98);
  for (const value of [10000000, '10000000.00', 1e100]) {
    assert.ok(prices(product(value)).error);
    assert.ok(prices(product(525, value)).error);
  }
  assert.ok(prices(product(5250000, null)).error);
});
