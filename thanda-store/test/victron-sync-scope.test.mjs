import test from 'node:test';
import assert from 'node:assert/strict';
import { selectVictronSyncProducts } from '../src/lib/victron-sync-scope.mjs';
import { exclusion } from '../src/lib/victron-catalogue-review.mjs';

const now = Date.parse('2026-10-23T10:00:00Z');
const product = (sku, extra = {}) => ({ sku, description: `Victron ${sku}`, currency: 'ZAR', price: 525, enduser_price_zar: { price: 1000 }, ...extra });
const context = (skus = []) => ({ now, existing: [], inventory: { company: 'thanda-solar', snapshot: 'revision', observed_at: '2026-10-23T09:30:00Z',
  items: skus.map(Code => ({ Code, ItemID: `id-${Code}`, IsTrackedAsInventory: true, QuantityOnHand: 0 })) },
run: { last_status: 'success', last_successful_at: '2026-10-23T09:35:00Z' } });

test('XS70 and every existing Store article refresh without any quarterly file or current inventory dependency', () => {
  const source = [product('ORI121221040'), product('SPM040303604'), product('PIN120', { description: '120V inverter' })];
  const result = selectVictronSyncProducts(source, { existing: source.map(row => ({ ...row, details: { hidden: true } })), now });
  assert.deepEqual(result.products.map(row => row.sku), ['ORI121221040', 'PIN120', 'SPM040303604']);
  assert.equal(result.inventoryReady, false);
  assert.equal(result.added.length, 0);
});

test('new approved ordinary E-Order SKUs appear without modifying a list; unapproved items stay in catalogue review', () => {
  const result = selectVictronSyncProducts([product('NEW001'), product('NOTAPPROVED001')], context(['NEW001']));
  assert.deepEqual(result.added, ['NEW001']);
  assert.match(result.skipped[0].reason, /tracked Thanda/);
});

test('panels remain excluded and regional advice requires the saved approval for Thanda', () => {
  const panel = product('SPM040303604');
  const regional = product('BPC120001', { description: '120V charger' });
  const products = [panel, regional];
  const input = context(products.map(row => row.sku));
  assert.deepEqual(selectVictronSyncProducts(products, input).added, []);
  assert.deepEqual(selectVictronSyncProducts(products, { ...input, decisions: [{ company: 'sensible-solar', sku: regional.sku, approvedReason: exclusion(regional) }] }).added, []);
  assert.deepEqual(selectVictronSyncProducts(products, { ...input, decisions: [{ company: 'thanda-solar', sku: regional.sku, approvedReason: exclusion(regional) }] }).added, [regional.sku]);
});

test('base and retail packaging cannot create duplicate Store articles', () => {
  const source = [product('PMP482305012R'), product('PMP482305012')];
  assert.deepEqual(selectVictronSyncProducts(source, context(source.map(row => row.sku))).added, ['PMP482305012']);
  assert.deepEqual(selectVictronSyncProducts(source, { ...context(source.map(row => row.sku)), existing: [{ sku: 'PMP482305012R' }] }).products.map(row => row.sku), ['PMP482305012R']);
});

test('a manually curated Store listing keeps ownership of its Xero identity', () => {
  const input = context(['NEW001']);
  const result = selectVictronSyncProducts([product('NEW001')], { ...input,
    otherProducts: [{ supplier: 'thanda', sku: 'CUSTOM001', details: { xeroItemId: 'id-NEW001', storeManaged: true } }] });
  assert.deepEqual(result.added, []);
  assert.match(result.skipped[0].reason, /already has a Store listing/);
});

test('missing, stale, failed, wrong-company, malformed or future inventory defers only new listings', () => {
  const existing = [{ sku: 'ORI121221040' }];
  const source = [product('ORI121221040'), product('NEW001')];
  const input = context(['NEW001']);
  for (const patch of [{ inventory: null }, { inventory: { ...input.inventory, observed_at: '2026-10-23T07:59:00Z' } },
    { inventory: { ...input.inventory, observed_at: '2026-10-24T10:00:00Z' } }, { inventory: { ...input.inventory, company: 'sensible-solar' } },
    { inventory: { ...input.inventory, items: [...input.inventory.items, ...input.inventory.items] } }, { run: { ...input.run, last_status: 'failed' } }]) {
    const result = selectVictronSyncProducts(source, { ...input, ...patch, existing });
    assert.deepEqual(result.products.map(row => row.sku), ['ORI121221040']);
    assert.match(result.discoveryDeferred, /await/);
  }
});

test('absent current products keep their own stock evidence and phase-outs or invalid prices do not become new listings', () => {
  const source = [product('ENDING001', { description: 'If 0, order NEW001' }), product('BAD001', { price: 0 }), product('NEW001')];
  const result = selectVictronSyncProducts(source, { ...context(source.map(row => row.sku)), existing: [{ sku: 'OLD-MISSING001' }] });
  assert.deepEqual(result.absentExisting, ['OLD-MISSING001']);
  assert.deepEqual(result.added, ['NEW001']);
});
