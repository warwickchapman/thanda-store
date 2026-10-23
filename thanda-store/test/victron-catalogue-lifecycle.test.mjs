import test from 'node:test';
import assert from 'node:assert/strict';
import { retirementReason, recordCatalogueLifecycle } from '../src/lib/victron-catalogue-lifecycle.mjs';

test('succession and end-of-life require confirmed zero or complete-scan absence', () => {
  const old = { name: 'Old panel *If 0, order SPM040203603*' };
  assert.match(retirementReason(old, null, 'SPM040203603'), /Superseded/);
  assert.equal(retirementReason(old, { stock_quantity: 2 }, 'SPM040203603'), null);
  assert.equal(retirementReason(old, { stock_quantity: null }, 'SPM040203603'), null);
  assert.match(retirementReason(old, { stock_quantity: 0 }, 'SPM040203603'), /Superseded/);
  const ending = { name: 'Cable *Available until stock 0*' };
  assert.match(retirementReason(ending, { stock_quantity: 0 }, null), /now zero/);
  assert.match(retirementReason(ending, null, null), /Removed.*review remaining stock/i);
  assert.match(retirementReason({ name: 'ordinary' }, null, null), /Removed.*review remaining stock/i);
});

test('complete supplier observations retain directed succession evidence without manufacturing stock', async () => {
  const observedAt = new Date().toISOString();
  const writes = [];
  const db = { query: async (sql, args) => {
    if (sql.startsWith('SELECT sku,name,details')) return { rows: [
      { sku: 'PMP482305010', name: 'Old MultiPlus', details: {} },
      { sku: 'PMP482305012', name: 'Current MultiPlus', details: { purchasingRetiredReason: 'Previously absent' } },
    ] };
    if (sql.startsWith('SELECT predecessor_sku')) return { rows: [{ predecessor_sku: 'PMP482305010', successor_sku: 'PMP482305012' }] };
    assert.ok(sql.startsWith('UPDATE products SET details=details ||'));
    writes.push({ sku: args[0], details: JSON.parse(args[1]) });
    return { rows: [] };
  } };
  await recordCatalogueLifecycle(db, [{ sku: 'PMP482305012', description: 'Current MultiPlus', stock_quantity: 5, currency: 'ZAR', price: 100 }], observedAt);
  assert.equal(writes.length, 2);
  assert.match(writes[0].details.purchasingRetiredReason, /Superseded by PMP482305012/);
  assert.equal(writes[0].details.cataloguePresent, false);
  assert.equal(writes[1].details.cataloguePresent, true);
  assert.equal(writes[1].details.purchasingRetiredReason, null);
  for (const write of writes) {
    assert.equal(write.details.catalogueObservedAt, observedAt);
    assert.ok(!Object.hasOwn(write.details, 'localStockOnHand'));
    assert.ok(!Object.hasOwn(write.details, 'xeroStockStatus'));
  }
  await assert.rejects(recordCatalogueLifecycle(db, [], observedAt), /Empty catalogue/);
});

test('product-name advice to CERBO does not become a false replacement in retained lifecycle evidence', async () => {
  const writes = [];
  const db = { query: async (sql, args) => {
    if (sql.startsWith('SELECT sku,name,details')) return { rows: [
      { sku: 'BPP900400100', name: 'Venus GX *If 0, order Cerbo GX MK2*', details: {} },
      { sku: 'BPP900450100', name: 'GX product *If 0, order Cerbo GX MK2*', details: {} },
    ] };
    if (sql.startsWith('SELECT predecessor_sku')) return { rows: [
      { predecessor_sku: 'BPP900400100', successor_sku: 'CERBO' },
      { predecessor_sku: 'BPP900450100', successor_sku: 'CERBO' },
    ] };
    writes.push(JSON.parse(args[1]));
    return { rows: [] };
  } };
  await recordCatalogueLifecycle(db, [{ sku: 'PMP482305012', description: 'Current product' }], '2026-10-23T10:00:00Z');
  assert.equal(writes.length, 2);
  for (const details of writes) {
    assert.match(details.purchasingRetiredReason, /Removed.*review remaining stock/i);
    assert.doesNotMatch(details.purchasingRetiredReason, /Superseded|CERBO/);
  }
});
