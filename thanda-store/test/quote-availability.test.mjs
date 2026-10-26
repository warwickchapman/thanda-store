import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteAvailability } from '../src/lib/commerce/quote-availability.mjs';

const now = new Date('2026-10-26T12:00:00Z');
const observed = minutes => new Date(now.getTime() + minutes * 60_000).toISOString();
const product = (supplier = 'victron', local = 0, stock = 0, details = {}) => ({
  supplier, sku: 'PMP482305010', stock_on_hand: stock,
  details: { localStockOnHand: local, xeroStockStatus: 'tracked', xeroStockSyncedAt: observed(-5),
    supplierStockStatus: 'known', supplierObservedAt: observed(-5), ...details },
});
const quote = (item, quantity = 1, options = {}) => quoteAvailability(item, quantity, { now, ...options });
const enquiry = 'Stock availability on enquiry.';
const local = 'Stock available. Subject to prior sale.';
const partial = quantity => `x${quantity} available in stock. Subject to prior sale.\n`;
const lead = (days, balance = false) => `Estimated lead time${balance ? ' for the balance' : ''}: ${days} working days, subject to confirmation.`;
const planned = (date, balance = false) => `Estimated lead time${balance ? ' for the balance' : ''}: around ${date}, plus 5-7 working days. Subject to supplier confirmation; timing may change.`;
const backorder = (quantity, planned_for = '2026-11-02', patch = {}) => ({
  sku: 'PMP482305010', quantity, planned_for, observed_at: observed(-5), last_error: null, ...patch,
});

test('fresh tracked Thanda stock covers the full quantity for every brand', () => {
  for (const supplier of ['victron', 'renogy', 'hubble', 'lora', 'enertec']) {
    assert.equal(quote(product(supplier, 3), 3), local);
  }
  assert.equal(quote(product('victron', 2, 0, { cataloguePresent: false }), 2), local);
  assert.equal(quote(product('victron', '2'), '2'), local);
});

test('fresh supplier stock must cover the whole request or the known local balance', () => {
  for (const [supplier, days] of [['renogy', '2-4'], ['victron', '5-7']]) {
    assert.equal(quote(product(supplier, 0, 3), 3), lead(days));
    assert.equal(quote(product(supplier, 1, 2), 3), partial(1) + lead(days, true));
    assert.equal(quote(product(supplier, 1, 1), 3), partial(1) + 'Stock availability for the balance on enquiry.');
    assert.equal(quote(product(supplier, 0, 2), 3), enquiry);
  }
});

test('unknown local stock never reduces the quantity required from the supplier', () => {
  for (const details of [{ xeroStockStatus: 'missing' }, { xeroStockStatus: 'untracked' },
    { xeroStockStatus: undefined }, { xeroStockSyncedAt: null }, { xeroStockSyncedAt: observed(-121) },
    { xeroStockSyncedAt: observed(6) }]) {
    assert.equal(quote(product('victron', 3, 1, details), 3), enquiry);
    assert.equal(quote(product('victron', 3, 3, details), 3), lead('5-7'));
  }
});

test('freshness windows and five-minute clock skew use source observation times', () => {
  assert.equal(quote(product('victron', 1, 0, { xeroStockSyncedAt: observed(-120) })), local);
  assert.equal(quote(product('victron', 1, 0, { xeroStockSyncedAt: observed(-120.01) })), enquiry);
  assert.equal(quote(product('victron', 1, 0, { xeroStockSyncedAt: observed(5) })), local);
  assert.equal(quote(product('victron', 1, 0, { xeroStockSyncedAt: observed(5.01) })), enquiry);
  for (const [supplier, minutes, days] of [['renogy', 20, '2-4'], ['victron', 300, '5-7']]) {
    assert.equal(quote(product(supplier, 0, 1, { supplierObservedAt: observed(-minutes) })), lead(days));
    assert.equal(quote(product(supplier, 0, 1, { supplierObservedAt: observed(-minutes - 0.01) })), enquiry);
    assert.equal(quote(product(supplier, 0, 1, { supplierObservedAt: observed(5) })), lead(days));
    assert.equal(quote(product(supplier, 0, 1, { supplierObservedAt: observed(5.01) })), enquiry);
  }
  assert.equal(quote({ ...product('renogy', 0, 1, { supplierObservedAt: null }), last_updated: now }), enquiry);
});

test('unknown, zero, malformed and negative observations do not assert stock', () => {
  for (const invalid of [null, undefined, '', ' ', false, true, [], [3], {}, NaN, Infinity, -1, '-1', 'invalid']) {
    assert.equal(quote(product('victron', invalid, invalid)), enquiry, `stock ${JSON.stringify(invalid)}`);
  }
  assert.equal(quote(product('victron', 0, 0)), enquiry);
  for (const details of [{ supplierStockStatus: 'unknown' }, { supplierStockManaged: false },
    { supplierObservedAt: null }, { supplierObservedAt: 'invalid' }, { cataloguePresent: false }]) {
    assert.equal(quote(product('victron', 0, 100, details)), enquiry);
  }
});

test('manual availability copy and unsupported supplier balances cannot establish a lead time', () => {
  for (const supplier of ['hubble', 'lora', 'enertec', 'ctek', 'other']) {
    assert.equal(quote(product(supplier, 0, 100, { manualAvailability: 'Generally available in 1–2 days' })), enquiry);
    assert.equal(quote(product(supplier, 1, 100), 2), partial(1) + 'Stock availability for the balance on enquiry.');
  }
});

test('invalid quote quantities, products and clocks return an enquiry', () => {
  for (const quantity of [null, '', ' ', true, [], [1], {}, NaN, Infinity, 0, -1]) {
    assert.equal(quote(product('victron', 100, 100), quantity), enquiry);
  }
  assert.equal(quoteAvailability(product('victron', 100), undefined, { now }), enquiry);
  assert.equal(quote(null), enquiry);
  assert.equal(quote(product('victron', 100), 1, { now: 'invalid' }), enquiry);
});

test('future Victron supply uses the first date whose cumulative uncommitted quantity covers the request', () => {
  const backorders = [backorder(2, '2026-11-04'), backorder(1, '2026-11-02'), backorder(50, '2026-11-10')];
  assert.equal(quote(product(), 3, { backorders }), planned('4 November 2026'));
  assert.equal(quote(product('victron', 1), 3, { backorders }), partial(1) + planned('4 November 2026', true));
  assert.equal(quote(product('victron', 0, 3), 3, { backorders }), lead('5-7'));
  assert.equal(quote(product(), 100, { backorders }), enquiry);
});

test('backorders accept R packaging for the exact selected article but never successor stock', () => {
  assert.equal(quote(product(), 2, { backorders: [backorder(2, '2026-11-02', { sku: 'pmp482305010r' })] }), planned('2 November 2026'));
  const retail = { ...product(), sku: 'PMP482305010R' };
  assert.equal(quote(retail, 2, { backorders: [backorder(2)] }), planned('2 November 2026'));
  assert.equal(quote(product(), 2, { backorders: [backorder(2, '2026-11-02', { sku: 'PMP482305012' })] }), enquiry,
    'PMP482305010 → PMP482305012 does not move committed quote supply between articles');
});

test('backorder estimates require current successful observations, positive quantity and strict future dates', () => {
  for (const patch of [{ observed_at: observed(-180.01) }, { observed_at: observed(5.01) }, { observed_at: null },
    { last_error: 'Sync failed' }, { quantity: 0 }, { quantity: -1 }, { quantity: [] }, { quantity: true },
    { planned_for: '2026-10-26' }, { planned_for: '2026-10-25' }, { planned_for: '2026-02-30' },
    { planned_for: '2027-02-29' }, { planned_for: '2026-11-02T00:00:00Z' }, { planned_for: '02/11/2026' },
    { planned_for: '2026-11-02 extra' }, { planned_for: null }]) {
    assert.equal(quote(product(), 1, { backorders: [backorder(10, '2026-11-02', patch)] }), enquiry, JSON.stringify(patch));
  }
  assert.equal(quote(product(), 1, { backorders: [backorder(1, '2026-11-02', { observed_at: observed(-180) })] }), planned('2 November 2026'));
  assert.equal(quote(product(), 1, { backorders: [backorder(1, '2026-11-02', { observed_at: observed(5) })] }), planned('2 November 2026'));
  assert.equal(quote(product(), 1, { now: new Date('2026-10-26T22:30:00Z'), backorders: [backorder(1, '2026-10-27', { observed_at: '2026-10-26T22:25:00Z' })] }), enquiry,
    'tomorrow in UTC is already today in South Africa');
});

test('removed catalogue articles and non-Victron lines never use backorder estimates', () => {
  for (const item of [product('victron', 0, 0, { cataloguePresent: false }), product('renogy'), product('enertec')]) {
    assert.equal(quote(item, 1, { backorders: [backorder(10)] }), enquiry);
  }
});

test('describing a quote does not mutate stock or backorder evidence or expose private details', () => {
  const item = product('victron', 1, 0, { distributorPriceExVat: 123, privateToken: 'secret' });
  const backorders = [backorder(1, '2026-11-10'), backorder(1, '2026-11-02')];
  const original = structuredClone({ item, backorders });
  const result = quote(item, 3, { backorders });
  assert.deepEqual({ item, backorders }, original);
  assert.equal(result, partial(1) + planned('10 November 2026', true));
  assert.ok(!result.includes('secret') && !result.includes('123'));
});
