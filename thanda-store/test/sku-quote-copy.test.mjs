import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as successions from '../src/lib/sku-successions.mjs';
import * as quoteLines from '../src/lib/commerce/quote-line.mjs';

const compiled = ts.transpileModule(fs.readFileSync(new URL('../src/app/api/account/quotes/[quoteId]/copy/route.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const old = 'RBT12100LFP-M-G1-SA';
const current = 'RBT12100LFP-M-G2-SA';
const pair = { supplier: 'renogy', predecessor_sku: old, successor_sku: current };
const card = (id, supplier, sku) => ({ id, supplier, sku, name: sku, your_price_ex_vat: id * 100,
  recommended_retail_ex_vat: id * 150, b2b_discount_percent: 30 });

async function copy(sku, products, relations = [pair]) {
  const audit = [];
  const user = { id: 7, xeroContactId: 'fixture-contact', discounts: {} };
  const unexpectedExternalCall = () => { throw new Error('Quote-copy preview must use stored data only'); };
  const modules = {
    'next/server': { NextResponse: Response },
    '@/lib/auth/server': { currentUser: async () => user },
    '@/lib/catalogue': { currentCatalogue: async () => products },
    '@/lib/db': { query: async (sql) => {
      const supplier = sql.includes('FROM renogy_sku_successions') ? 'renogy' : sql.includes('FROM victron_sku_successions') ? 'victron' : null;
      assert.ok(supplier, `Unexpected query: ${sql}`);
      return { rows: relations.filter((row) => row.supplier === supplier) };
    } },
    '@/lib/sku-successions.mjs': successions,
    '@/lib/victron-fulfilment': {},
    '@/lib/xero/customer-accounts': {
      customerDocument: async () => ({ payload: { Contact: { ContactID: user.xeroContactId }, QuoteNumber: 'Q-fixture', LineItems: [{ ItemCode: sku, Quantity: 2 }] } }),
      auditAccountAction: async (...args) => audit.push(args),
    },
    '@/lib/xero/oauth': { xeroAccountingFetch: unexpectedExternalCall },
    '@/lib/commerce/quote-requests.mjs': {},
    '@/lib/commerce/quote-line.mjs': quoteLines,
    '@/lib/quote-settings': {},
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: (name) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
    return modules[name];
  }, fetch: unexpectedExternalCall });
  const response = await exports.GET(new Request('https://store.example.test/api/account/quotes/fixture/copy'), { params: Promise.resolve({ quoteId: 'fixture' }) });
  assert.equal(response.status, 200);
  return { ...await response.json(), audit };
}

test('quote copy never mistakes another brand card for a retired Renogy code', async () => {
  const result = await copy(old, [card(1, 'victron', old), card(2, 'renogy', current)]);
  assert.deepEqual(result.lines, []);
  assert.deepEqual(result.skipped, [old]);
  assert.deepEqual(Array.from(result.audit[0][4].skippedSkus), [old]);
});

test('quote copy also treats a supplier successor code as known identity before choosing an exact card', async () => {
  const result = await copy(current, [card(1, 'victron', current)]);
  assert.deepEqual(result.lines, []);
  assert.deepEqual(result.skipped, [current]);
});

test('unambiguous old Renogy code copies the current SKU and its own price', async () => {
  const result = await copy(old, [card(2, 'renogy', current)]);
  assert.equal(result.lines[0].sku, current);
  assert.equal(result.lines[0].unitPrice, 200);
  assert.equal(result.lines[0].quantity, 2);
  assert.deepEqual(result.skipped, []);
});

test('quote copy follows canonical PMP482305010 history and Victron retail packaging aliases', async () => {
  const relation = { supplier: 'victron', predecessor_sku: 'PMP482305010', successor_sku: 'PMP482305012' };
  for (const sku of ['PMP482305010', 'PMP482305010R', 'PMP482305012R']) {
    const result = await copy(sku, [card(3, 'victron', 'PMP482305012')], [relation]);
    assert.equal(result.lines[0].sku, 'PMP482305012');
    assert.deepEqual(result.skipped, []);
  }
});

test('quote copy keeps a literal Renogy final R distinct from its predecessor code', async () => {
  const result = await copy(`${old}R`, [card(2, 'renogy', current)]);
  assert.deepEqual(result.lines, []);
  assert.deepEqual(result.skipped, [`${old}R`]);
});
