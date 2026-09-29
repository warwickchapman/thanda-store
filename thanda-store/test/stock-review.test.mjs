import test from 'node:test';
import assert from 'node:assert/strict';
import { activeStockReview, checkedXeroItem } from '../src/lib/stock-review.mjs';
import { localStockObservation, DATA_SOURCES } from '../src/lib/data-freshness.mjs';
import { stockHealthIssues } from '../src/lib/data-health-actions.mjs';
import { replenishmentFamilyStocks } from '../src/lib/victron-replenishment.mjs';

const observedAt = new Date().toISOString();
test('acknowledgements silence only missing-item health issues and never fabricate Xero stock', () => {
  const product = { sku: 'PMP482305010', supplier: 'victron', details: { xeroStockStatus: 'missing', xeroStockSyncedAt: observedAt }, stockReview: { decision: 'do_not_stock' } };
  assert.ok(activeStockReview(product));
  assert.equal(localStockObservation(product).quantity, null);
  const source = DATA_SOURCES.find(item => item.id === 'thanda');
  assert.equal(stockHealthIssues(source, [product]).length, 0);
  product.stockReview.decision = null;
  assert.equal(stockHealthIssues(source, [product]).length, 1);
});
test('real Xero observations supersede both review decisions', () => {
  for (const decision of ['do_not_stock', 'retired']) {
    const product = { details: { xeroStockStatus: 'tracked', localStockOnHand: 4, xeroStockSyncedAt: observedAt }, stockReview: { decision } };
    assert.equal(activeStockReview(product), null);
    assert.equal(localStockObservation(product).quantity, 4);
    product.details.xeroStockStatus = 'untracked';
    assert.equal(activeStockReview(product), null);
  }
});
test('a reviewed predecessor does not erase successor stock or change family calculations', () => {
  const products = [
    { sku: 'PMP482305010', details: { xeroStockStatus: 'tracked', xeroStockSyncedAt: observedAt, localStockOnHand: 2 }, stockReview: { decision: 'retired' } },
    { sku: 'PMP482305012', details: { xeroStockStatus: 'tracked', xeroStockSyncedAt: observedAt, localStockOnHand: 3 } },
  ];
  const result = replenishmentFamilyStocks(products, [{ predecessor_sku: 'PMP482305010', successor_sku: 'PMP482305012' }], { checkedAt: observedAt, staleAfterMinutes: 120 });
  assert.equal(result.get('PMP482305010').localStock, 5);
});
test('Xero check distinguishes absent, untracked, unknown quantity and tracked zero', () => {
  assert.equal(checkedXeroItem([], 'A', observedAt).status, 'missing');
  assert.equal(checkedXeroItem([{ Code: 'A', IsTrackedAsInventory: false, QuantityOnHand: 10 }], 'A', observedAt).quantity, null);
  for (const quantity of [null, undefined, '', false, 'invalid']) {
    assert.equal(checkedXeroItem([{ Code: 'A', IsTrackedAsInventory: true, QuantityOnHand: quantity }], 'A', observedAt).quantity, null);
  }
  assert.equal(checkedXeroItem([{ Code: 'a', IsTrackedAsInventory: true, QuantityOnHand: 0 }], 'A', observedAt).quantity, 0);
  assert.throws(() => checkedXeroItem([{ Code: 'A' }, { Code: 'a' }], 'A', observedAt), /More than one/);
  assert.throws(() => checkedXeroItem([], 'A', ''), /observation time/);
  assert.throws(() => checkedXeroItem([], 'A', new Date(Date.now() + 3600_000).toISOString()), /observation time/);
});
