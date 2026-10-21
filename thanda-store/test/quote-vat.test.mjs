import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import test from 'node:test';
import { quoteLineItem } from '../src/lib/commerce/quote-line.mjs';
import { QuoteRequestLimitError, validRequestId } from '../src/lib/commerce/quote-requests.mjs';

const product = {
  sku: 'BPC120533034R', name: 'Blue Smart IP65s Charger 12/5',
  recommended_retail_ex_vat: 1664, b2b_discount_percent: 40,
  details: { xeroStockStatus: 'tracked' },
};

test('quote lines explicitly request standard sales VAT without changing ex-VAT prices or discounts', () => {
  assert.deepEqual(quoteLineItem(product, 1), {
    ItemCode: product.sku, Description: product.name, Quantity: 1,
    UnitAmount: 1664, DiscountRate: 40, TaxType: 'OUTPUT3',
  });
  assert.equal(product.details.xeroStockStatus, 'tracked');
});

test('non-Xero catalogue lines still carry VAT and do not invent an ItemCode', () => {
  const line = quoteLineItem({ ...product, details: { xeroStockStatus: 'missing' }, b2b_discount_percent: 0 }, 3);
  assert.equal(line.TaxType, 'OUTPUT3');
  assert.equal(line.Quantity, 3);
  assert.equal(line.DiscountRate, 0);
  assert.equal('ItemCode' in line, false);
  assert.equal('TaxAmount' in line, false);
});

for (const path of ['../src/app/api/quotes/route.ts', '../src/app/api/account/quotes/[quoteId]/copy/route.ts']) {
  for (const status of ['DRAFT', 'SENT']) {
    test(`${path} submits explicit VAT for ${status} without calling Xero`, async () => {
      const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
      }).outputText;
      let submitted;
      let resumes = 0;
      const current = { ...product, id: 7, your_price_ex_vat: 998.4 };
      const user = { id: 1, xeroContactId: 'fixture-contact', organisationName: 'Fixture', email: 'fixture@example.test', discounts: {} };
      const modules = {
        'next/server': { NextResponse: Response },
        '@/lib/db': { query: async () => ({ rowCount: 1, rows: [{ product_id: 7, quantity: 1, updated_at: '2026-10-21' }] }) },
        '@/lib/catalogue': { currentCatalogue: async () => [current] },
        '@/lib/auth/server': { currentUser: async () => user },
        '@/lib/xero/oauth': { xeroAccountingFetch: () => { throw new Error('Unexpected provider call'); } },
        '@/lib/victron-fulfilment': { resolveFulfilmentProduct: async () => current, isSupplierProductAvailable: () => true },
        '@/lib/commerce/quote-line.mjs': { quoteLineItem },
        '@/lib/commerce/quote-requests.mjs': {
          QuoteRequestLimitError, validRequestId,
          resumeQuoteRequest: async () => ++resumes === 1 ? null : { quoteId: 'fixture' },
          recordQuoteRequest: async (_pool, _user, _id, payload) => { submitted = payload; },
        },
        '@/lib/quote-settings': { customerQuoteStatus: async () => status },
        '@/lib/sku-successions.mjs': {},
        '@/lib/xero/customer-accounts': { customerDocument: async () => ({ payload: { Contact: { ContactID: user.xeroContactId }, QuoteNumber: 'Q-original' } }) },
      };
      const exports = {};
      vm.runInNewContext(compiled, { exports, process: { env: {} }, console, require: name => {
        assert(Object.hasOwn(modules, name), `Unexpected dependency ${name}`);
        return modules[name];
      } });
      const request = new Request('https://store.example.test/api/quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: '11111111-1111-4111-8111-111111111111', quoteReference: 'VAT test', lines: [{ productId: 7, quantity: 1 }] }) });
      const response = await exports.POST(request, { params: Promise.resolve({ quoteId: 'original' }) });
      assert.equal(response.status, 200, await response.text());
      assert.equal(submitted.Quotes[0].Status, status);
      assert.equal(submitted.Quotes[0].LineAmountTypes, 'Exclusive');
      assert.equal(submitted.Quotes[0].LineItems[0].TaxType, 'OUTPUT3');
      assert.equal(submitted.Quotes[0].LineItems[0].UnitAmount, 1664);
      assert.equal(submitted.Quotes[0].LineItems[0].DiscountRate, 40);
    });
  }
}
