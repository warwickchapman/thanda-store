import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { sortSearchProducts } from '../src/lib/catalogue-search-order.mjs';
import * as favourites from '../src/lib/favourite-products.mjs';
import * as successions from '../src/lib/sku-successions.mjs';

const now = Date.parse('2026-10-28T08:00:00Z');
const product = (id, name, sku = `SKU-${id}`, supplier = 'victron') => ({ id, name, sku, supplier, stock_on_hand: 2, details: {} });
const sale = (sku, quantity, id = sku) => ({ sku, quantity, invoice_id: id, invoice_date: '2026-10-01' });
const relations = [
  { supplier: 'victron', predecessor_sku: 'PMP482305010', successor_sku: 'PMP482305012' },
  { supplier: 'renogy', predecessor_sku: 'RENOGY-G1', successor_sku: 'RENOGY-G2' },
];

test('search ranks net units rather than invoice count or recency, then names', () => {
  const products = [product(1, 'Zulu'), product(2, 'Alpha'), product(3, 'Bravo'), product(4, 'Credited'), product(5, 'No sales')];
  const history = [sale('SKU-1', 10), sale('SKU-2', 1, 'invoice-1'), sale('SKU-2', 1, 'invoice-2'), sale('SKU-2', 1, 'invoice-3'),
    sale('SKU-3', 3), sale('SKU-4', 2), sale('SKU-4', -2, 'credit-note')];
  const ids = favourites.popularSearchProductIds(history, products, [], now);
  assert.deepEqual(ids, [1, 2, 3]);
  assert.deepEqual(sortSearchProducts(products, ids).map(row => row.id), [1, 2, 3, 4, 5]);
  assert(products.every(row => !Object.hasOwn(row, 'units') && !Object.hasOwn(row, 'sales')));
});

test('zero, fully credited and negative-net products sort by name with natural numbers', () => {
  const products = [product(1, 'MEGA fuse 100A'), product(2, 'mega fuse 20A'), product(3, 'Adapter'), product(4, 'Mega fuse 80A')];
  const history = [sale('SKU-1', 2), sale('SKU-1', -2, 'credit-1'), sale('SKU-2', -1, 'credit-2')];
  assert.deepEqual(favourites.popularSearchProductIds(history, products, [], now), []);
  assert.deepEqual(sortSearchProducts(products).map(row => row.id), [3, 2, 4, 1]);
  assert.deepEqual(products.map(row => row.id), [1, 2, 3, 4], 'Do not mutate catalogue or Home ordering');
});

test('PMP predecessor sales, retail packaging and credits rank the current family together', () => {
  const products = [product(1, 'Current MultiPlus', 'PMP482305012'), product(2, 'Old MultiPlus', 'PMP482305010'), product(3, 'Other')];
  const history = [sale('PMP482305010', 3), sale('PMP482305012R', 4), sale('PMP482305010R', -2, 'credit'), sale('SKU-3', 6)];
  assert.deepEqual(favourites.popularSearchProductIds(history, products, relations, now), [3, 1, 2]);
  assert.equal(products[0].stock_on_hand, 2);
  assert.equal(products[1].sku, 'PMP482305010');
});

test('fully credited fractional quantities do not leave a false positive sale', () => {
  const products = [product(1, 'Zulu'), product(2, 'Alpha')];
  const history = [sale('SKU-1', '0.100', 'invoice-1'), sale('SKU-1', '0.200', 'invoice-2'), sale('SKU-1', '-0.300', 'credit')];
  assert.deepEqual(favourites.popularSearchProductIds(history, products, [], now), []);
  assert.deepEqual(sortSearchProducts(products).map(row => row.id), [2, 1]);
});

test('Renogy replacements share demand without stripping R or merging cross-brand collisions', () => {
  const products = [product(1, 'Current', 'RENOGY-G2', 'renogy'), product(2, 'Old', 'RENOGY-G1', 'renogy'),
    product(3, 'Separate R article', 'RENOGY-G1R', 'renogy')];
  const history = [sale('RENOGY-G1', 4), sale('RENOGY-G2', 2), sale('RENOGY-G1R', 5)];
  assert.deepEqual(favourites.popularSearchProductIds(history, products, relations, now), [1, 2, 3]);
  const collision = product(4, 'Unrelated Victron', 'RENOGY-G1');
  assert.deepEqual(favourites.popularSearchProductIds([sale('RENOGY-G1', 20)], [...products, collision], relations, now), []);
});

test('search includes popularity beyond the Home top 20 and alphabetises unsold matches', () => {
  const products = Array.from({ length: 25 }, (_, index) => product(index + 1, `Product ${index + 1}`));
  const history = products.map((row, index) => sale(row.sku, 25 - index));
  const ids = favourites.popularSearchProductIds(history, products, [], now);
  assert.equal(favourites.rankedFavouriteProducts(history, products, [], false, now).length, 20);
  assert.equal(ids.length, 25);
  assert.deepEqual(sortSearchProducts([product(99, 'A zero'), products[24]], ids).map(row => row.id), [25, 99]);
});

test('alphabetical ties use SKU and ID for deterministic results', () => {
  const products = [product(4, 'Fuse', 'Z'), product(2, 'fuse', 'A'), product(1, 'Fuse', 'A')];
  assert.deepEqual(sortSearchProducts(products).map(row => row.id), [1, 2, 4]);
});

const compiled = ts.transpileModule(readFileSync(new URL('../src/app/api/favourites/route.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;

function route(user) {
  const products = [product(1, 'Alpha'), product(2, 'Bravo')];
  const history = [sale('SKU-2', 3)];
  const queries = [];
  const modules = {
    'next/server': { NextResponse: Response },
    '@/lib/auth/server': { currentUser: async () => user },
    '@/lib/catalogue': { currentCatalogue: async () => products },
    '@/lib/favourite-products.mjs': favourites,
    '@/lib/sku-successions.mjs': successions,
    '@/lib/db': { __esModule: true, default: { query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('_sku_successions')) return { rows: [] };
      assert(sql.includes('xero_sales_invoice_lines'));
      return { rows: history };
    } } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, console, fetch() { throw new Error('No external calls permitted'); }, require: name => {
    assert(Object.hasOwn(modules, name), `Unexpected dependency ${name}`);
    return modules[name];
  } });
  return { GET: exports.GET, queries };
}

test('favourites supplies a buyer-scoped relative ordering using its existing local queries only', async () => {
  const api = route({ email: 'buyer@example.test', discounts: {}, xeroContactId: 'company' });
  const response = await api.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('vary'), 'Cookie');
  const payload = await response.json();
  assert.deepEqual(payload.popularProductIds, [2]);
  assert(payload.popularProductIds.every(Number.isSafeInteger));
  assert.equal(api.queries.length, 4, 'Two succession tables and the existing personal/global history reads');
  assert(api.queries.filter(({ sql }) => sql.includes('xero_sales_invoice_lines')).every(({ sql }) => sql.includes('invoice_date >=')));
});

test('unauthenticated requests cannot read popularity or query sales history', async () => {
  const api = route(null);
  assert.equal((await api.GET()).status, 401);
  assert.equal(api.queries.length, 0);
});
