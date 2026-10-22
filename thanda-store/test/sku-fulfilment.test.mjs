import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as successions from '../src/lib/sku-successions.mjs';
import * as catalogueAccess from '../src/lib/catalogue-access.mjs';

const compiled = ts.transpileModule(fs.readFileSync(new URL('../src/lib/victron-fulfilment.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const oldSku = 'RBT12100LFP-M-G1-SA';
const newSku = 'RBT12100LFP-M-G2-SA';
const observation = { supplierObservedAt: '2026-10-19T09:20:00Z' };

function harness(requested, products, relations) {
  const queries = [];
  const db = { query: async (sql, parameters) => {
    queries.push({ sql, parameters });
    if (sql.includes('FROM victron_sku_successions')) return { rows: relations.filter((row) => row.supplier === 'victron') };
    if (sql.includes('FROM renogy_sku_successions')) return { rows: relations.filter((row) => row.supplier === 'renogy') };
    if (sql.includes('WHERE id = $1')) return { rows: requested ? [requested] : [] };
    if (sql.includes('WHERE LOWER(supplier) = LOWER($1)')) {
      return { rows: products.filter((row) => row.supplier === parameters[0]
        && parameters[1].includes(successions.normalizeSku(row.supplier, row.sku))) };
    }
    throw new Error(`Unexpected database query: ${sql}`);
  } };
  const modules = { '@/lib/db': db, '@/lib/sku-successions.mjs': successions, '@/lib/catalogue-access.mjs': catalogueAccess };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: (name) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected I/O dependency: ${name}`);
    return modules[name];
  } });
  return { ...exports, queries };
}

test('actual fulfiller selects zero-stock Renogy successor without ordering historical unobserved stock', async () => {
  const old = { id: 1, supplier: 'renogy', sku: oldSku, stock_on_hand: 16, details: {} };
  const current = { id: 2, supplier: 'renogy', sku: newSku, stock_on_hand: 0, details: observation };
  const h = harness(old, [old, current], [{ supplier: 'renogy', predecessor_sku: oldSku, successor_sku: newSku }]);
  const selected = await h.resolveFulfilmentProduct(1);
  assert.equal(selected.id, 2);
  assert.equal(selected.sku, newSku);
  assert.equal(selected.hasStock, false);
  assert.equal(selected.substituted, true);
  assert.equal(h.isSupplierProductAvailable(selected), false);
  const familyQuery = h.queries.find((query) => query.parameters?.[0] === 'renogy');
  assert.deepEqual(Array.from(familyQuery.parameters[1]), [oldSku, newSku]);
});

test('actual fulfiller retains stocked PMP482305010 packaging when ordering PMP482305012', async () => {
  const old = { id: 1, supplier: 'victron', sku: 'PMP482305010R', stock_on_hand: 3, details: observation };
  const current = { id: 2, supplier: 'victron', sku: 'PMP482305012', stock_on_hand: 0, details: observation };
  const h = harness(current, [old, current], [{ supplier: 'victron', predecessor_sku: 'PMP482305010', successor_sku: 'PMP482305012' }]);
  const selected = await h.resolveFulfilmentProduct(2);
  assert.equal(selected.id, 1);
  assert.equal(selected.sku, 'PMP482305010R');
  assert.equal(h.isSupplierProductAvailable(selected), true);
});

test('actual fulfiller preserves a separate Renogy R article and never traverses Victron relations', async () => {
  const requested = { id: 1, supplier: 'renogy', sku: `${oldSku}R`, stock_on_hand: 2, details: observation };
  const unrelated = { id: 2, supplier: 'victron', sku: oldSku, stock_on_hand: 9, details: observation };
  const h = harness(requested, [requested, unrelated], [{ supplier: 'renogy', predecessor_sku: oldSku, successor_sku: newSku },
    { supplier: 'victron', predecessor_sku: oldSku, successor_sku: 'VIC-NEW' }]);
  const selected = await h.resolveFulfilmentProduct(1);
  assert.equal(selected.id, 1);
  assert.equal(selected.sku, `${oldSku}R`);
  assert.equal(selected.substituted, false);
});
