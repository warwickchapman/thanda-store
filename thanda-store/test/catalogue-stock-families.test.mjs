import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import ts from 'typescript';
import * as families from '../src/lib/catalogue-stock-families.mjs';
import * as freshness from '../src/lib/data-freshness.mjs';
import * as successions from '../src/lib/sku-successions.mjs';
import * as successionDetails from '../src/lib/catalogue-succession.mjs';
import * as access from '../src/lib/catalogue-access.mjs';
import * as filters from '../src/lib/catalogue-filters.mjs';
import { quoteLineItem } from '../src/lib/commerce/quote-line.mjs';

const observedAt = '2026-10-23T10:00:00.000Z';
const oldSku = 'PMP482305010';
const newSku = 'PMP482305012';
const edge = { supplier: 'victron', predecessor_sku: oldSku, successor_sku: newSku };
const product = (id, sku, local = 0, supplier = 0, details = {}) => ({
  id, sku, supplier: 'victron', name: sku, category: 'Inverter', image_url: '', price: id * 100,
  stock_on_hand: supplier,
  details: { localStockOnHand: local, xeroStockStatus: 'tracked', xeroStockSyncedAt: observedAt,
    supplierObservedAt: observedAt, supplierStockStatus: 'known', recommendedRetailExVat: id * 1000,
    cataloguePresent: true, ...details },
});
const summary = (rows, edges = [edge]) => families.catalogueStockFamilies(rows, edges);

test('PMP482305010 stock appears once on the current PMP482305012 card without moving accounting identities', () => {
  const old = product(1, oldSku, 3, 4);
  const current = product(2, newSku, 0, 0);
  const before = structuredClone([old, current]);
  const listed = summary([old, current]);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].row, current);
  assert.deepEqual(listed[0].stock.local, { status: 'known', quantity: 3 });
  assert.deepEqual(listed[0].stock.supplier, { status: 'known', quantity: 4 });
  assert.deepEqual([old, current], before, 'Display grouping must not mutate stored article rows.');
  const display = families.withCatalogueFamilyStock(current, listed[0].stock);
  assert.equal(display.details.localStockOnHand, 3);
  assert.equal(display.stock_on_hand, 4);
  assert.equal(display.sku, newSku);
  assert.equal(current.details.localStockOnHand, 0);
  assert.deepEqual(display.details.previousSkus, [oldSku]);
});

test('transitive families include hidden predecessor stock while keeping a visible current representative', () => {
  const latestSku = 'PMP482305014';
  const chain = [edge, { ...edge, predecessor_sku: newSku, successor_sku: latestSku }];
  for (const hidden of [true, 'true']) {
    const listed = summary([product(1, oldSku, 2, 3, { hidden }), product(2, newSku, 4, 5, { hidden }),
      product(3, latestSku, 6, 7)], chain);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].row.sku, latestSku);
    assert.deepEqual(listed[0].stock.local, { status: 'known', quantity: 12 });
    assert.deepEqual(listed[0].stock.supplier, { status: 'known', quantity: 15 });
    assert.deepEqual(listed[0].stock.skus, [oldSku, newSku, latestSku]);
  }
});

test('retail and base aliases contribute one observation per article, never duplicate Xero stock', () => {
  const listed = summary([product(1, `${oldSku}R`, 99, 99), product(2, oldSku, 3, 4),
    product(3, `${newSku}R`, 88, 88), product(4, newSku, 5, 6)]);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].row.sku, newSku);
  assert.deepEqual(listed[0].stock.local, { status: 'known', quantity: 8 });
  assert.deepEqual(listed[0].stock.supplier, { status: 'known', quantity: 10 });
});

test('a missing article observation preserves positive lower bounds and never establishes zero', () => {
  const unobserved = product(1, oldSku, 99, 99, { xeroStockStatus: 'missing', supplierObservedAt: null });
  const current = product(2, newSku, 2, 3);
  let listed = summary([unobserved, current])[0];
  assert.deepEqual(listed.stock.local, { status: 'partial', quantity: 2 });
  assert.deepEqual(listed.stock.supplier, { status: 'partial', quantity: 3 });
  listed = summary([unobserved, product(2, newSku, 0, 0)])[0];
  assert.deepEqual(listed.stock.local, { status: 'partial', quantity: null });
  assert.deepEqual(listed.stock.supplier, { status: 'partial', quantity: null });
});

test('future source timestamps cannot manufacture known family stock', () => {
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  const invalid = product(1, oldSku, 99, 99, { xeroStockSyncedAt: future, supplierObservedAt: future });
  const listed = summary([invalid, product(2, newSku, 0, 0)])[0];
  assert.deepEqual(listed.stock.local, { status: 'partial', quantity: null });
  assert.deepEqual(listed.stock.supplier, { status: 'partial', quantity: null });
});

test('a current successor not yet imported cannot remove the only real Store card', () => {
  const old = product(1, oldSku, 2, 3);
  const listed = summary([old]);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].row, old);
  assert.deepEqual(listed[0].stock.local, { status: 'partial', quantity: 2 });
  assert.deepEqual(listed[0].stock.skus, [oldSku, newSku]);
});

test('removed supplier articles contribute owned stock without resurrecting retained supplier stock', () => {
  const old = product(1, oldSku, 3, 999, { cataloguePresent: false });
  const listed = summary([old, product(2, newSku, 0, 4)])[0];
  assert.deepEqual(listed.stock.local, { status: 'known', quantity: 3 });
  assert.deepEqual(listed.stock.supplier, { status: 'known', quantity: 4 });
});

test('supplier boundaries, unrelated retail cards and malformed CERBO markers remain separate', () => {
  const unrelated = { ...product(3, oldSku, 80, 90), supplier: 'renogy' };
  const badEdges = [{ ...edge, successor_sku: 'CERBO' },
    { ...edge, predecessor_sku: 'BPP900400100', successor_sku: 'CERBO' }];
  const rows = [product(1, oldSku, 1, 2), product(2, 'BPP900400100', 3, 4), unrelated];
  const listed = summary(rows, badEdges);
  assert.equal(listed.length, 3);
  assert(listed.every(row => row.stock === null));
  assert.equal(summary([product(1, 'ORI121221040'), product(2, 'ORI121221040R')], []).length, 2,
    'Unrelated retail-only policy does not silently merge existing product cards.');
  assert.equal(summary([product(1, oldSku, 1, 1, { hidden: true }), product(2, newSku, 2, 2, { hidden: true })]).length, 0);
});

test('removed standalone Venus articles leave discovery unless confirmed owned stock remains, without Cerbo substitution', () => {
  const bad = [{ ...edge, predecessor_sku: 'BPP900400100', successor_sku: 'CERBO' }];
  const venus = product(1, 'BPP900400100', 0, 99, { cataloguePresent: false });
  assert.equal(summary([venus], bad).length, 0);
  assert.equal(summary([{ ...venus, details: { ...venus.details, xeroStockStatus: 'missing' } }], bad).length, 0,
    'Uncertain owned stock is not a positive quantity that can be offered for sale.');
  const stocked = { ...venus, details: { ...venus.details, localStockOnHand: 2 } };
  const listed = summary([stocked], bad);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].row, stocked);
  assert.equal(listed[0].stock, null);
  assert.equal(stocked.stock_on_hand, 99, 'Historical supplier balance remains in the source row.');
});

test('a fully removed family leaves discovery only when no confirmed owned stock remains', () => {
  const old = product(1, oldSku, 0, 99, { cataloguePresent: false });
  const current = product(2, newSku, 0, 88, { cataloguePresent: false });
  assert.equal(summary([old, current]).length, 0);
  const listed = summary([{ ...old, details: { ...old.details, hidden: true, localStockOnHand: 2 } }, current]);
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].stock.local, { status: 'known', quantity: 2 });
  assert.deepEqual(listed[0].stock.supplier, { status: 'unknown', quantity: null });
});

const compiled = ts.transpileModule(fs.readFileSync(new URL('../src/lib/catalogue.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;

function catalogue(rows, edges) {
  const db = { query: async sql => {
    if (sql.includes('FROM victron_sku_successions')) return { rows: edges.filter(row => row.supplier === 'victron') };
    if (sql.includes('FROM renogy_sku_successions')) return { rows: edges.filter(row => row.supplier === 'renogy') };
    if (sql.includes('FROM products')) return { rows };
    throw new Error(`Unexpected database query: ${sql}`);
  } };
  const modules = { 'node:fs': { existsSync: () => false }, 'node:path': path, '@/lib/db': db,
    '@/lib/catalogue-filters.mjs': filters, '@/lib/data-freshness.mjs': freshness,
    '@/lib/sku-successions.mjs': successions, '@/lib/catalogue-succession.mjs': successionDetails,
    '@/lib/catalogue-access.mjs': access, '@/lib/catalogue-stock-families.mjs': families };
  const exports = {};
  vm.runInNewContext(compiled, { exports, process: { cwd: () => '/synthetic', env: {} }, require: name => {
    assert(Object.hasOwn(modules, name), `Unexpected dependency ${name}`);
    return modules[name];
  } });
  return exports;
}

test('real catalogue groups discovery but raw cart and quote reads retain own SKU, quantities and prices', async () => {
  const old = product(1, oldSku, 3, 4);
  const current = product(2, newSku, 0, 0);
  const api = catalogue([old, current], [edge]);
  const listed = await api.currentCatalogue({ victron: 40 });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].sku, newSku);
  assert.equal(listed[0].details.localStockOnHand, 3);
  const raw = await api.currentCatalogue({ victron: 40 }, { includeSuperseded: true });
  assert.equal(raw.length, 2);
  assert.equal(raw[0].details.localStockOnHand, 3);
  assert.equal(raw[1].details.localStockOnHand, 0);
  assert.equal(raw[0].stock_on_hand, 4);
  assert.equal(raw[1].stock_on_hand, 0);
  assert.equal(quoteLineItem(raw[0], 1).ItemCode, oldSku);
  assert.equal(quoteLineItem(raw[0], 1).UnitAmount, 1000);
  assert.equal(quoteLineItem(raw[1], 1).ItemCode, newSku);
  assert.equal(quoteLineItem(raw[1], 1).UnitAmount, 2000);
});

test('literal commerce reads expose hidden stock only for a confirmed family with a visible current member', async () => {
  const old = product(1, oldSku, 3, 0, { hidden: true });
  const current = product(2, newSku, 0, 0);
  const otherHidden = product(3, 'BPP900400100', 10, 0, { hidden: true });
  const api = catalogue([old, current, otherHidden], [edge]);
  assert.equal((await api.currentCatalogue({})).length, 1);
  assert.equal((await api.currentCatalogue({}, { includeSuperseded: true })).length, 1);
  const commerce = await api.currentCatalogue({}, { includeSuperseded: true, includeHiddenFamilyStock: true });
  assert.deepEqual(Array.from(commerce, row => row.sku), [oldSku, newSku]);
  assert.equal(quoteLineItem(commerce[0], 1).ItemCode, oldSku);
  assert.equal(commerce[0].details.localStockOnHand, 3);
  const whollyHidden = catalogue([old, { ...current, details: { ...current.details, hidden: true } }], [edge]);
  assert.equal((await whollyHidden.currentCatalogue({}, { includeSuperseded: true, includeHiddenFamilyStock: true })).length, 0);
});

test('actual catalogue retains owned Venus stock with no supplier availability or invented Cerbo replacement', async () => {
  const venus = product(1, 'BPP900400100', 2, 99, { cataloguePresent: false });
  const api = catalogue([venus], [{ ...edge, predecessor_sku: venus.sku, successor_sku: 'CERBO' }]);
  const listed = await api.currentCatalogue({});
  assert.equal(listed.length, 1);
  assert.equal(listed[0].sku, venus.sku);
  assert.equal(listed[0].stock_on_hand, null);
  assert.equal(listed[0].details.supplierStockStatus, 'unknown');
  assert.equal(listed[0].details.localStockOnHand, 2);
  assert.deepEqual(Array.from(listed[0].details.replacedBy), []);
  assert.equal(quoteLineItem(listed[0], 1).ItemCode, venus.sku);
});
