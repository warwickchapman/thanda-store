// Disposable local PostgreSQL only. Actual catalogue/commerce routes use stored
// fixtures; authentication and the cached source quote are the only substitutes.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import pg from 'pg';
import ts from 'typescript';
import { ensureProductSchema } from '../scripts/product-sync-lib.mjs';
import * as successionAdmin from '../src/lib/renogy-sku-successions.mjs';
import * as successions from '../src/lib/sku-successions.mjs';
import * as catalogueSuccession from '../src/lib/catalogue-succession.mjs';
import * as catalogueFilters from '../src/lib/catalogue-filters.mjs';
import * as freshness from '../src/lib/data-freshness.mjs';
import * as favourites from '../src/lib/favourite-products.mjs';
import * as catalogueExport from '../src/lib/commerce/catalogue-export.mjs';

if (process.env.RUN_RENOGY_SUCCESSIONS_DB_TESTS !== '1' || !process.env.DATABASE_URL) {
  throw new Error('Set RUN_RENOGY_SUCCESSIONS_DB_TESTS=1 and a local disposable DATABASE_URL.');
}
const url = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use a local disposable database.');
const schema = `renogy_successions_test_${crypto.randomBytes(6).toString('hex')}`;
const admin = new pg.Pool({ connectionString: url.toString() });
url.searchParams.set('options', `-c search_path=${schema}`);
const pool = new pg.Pool({ connectionString: url.toString() });
const observedAt = new Date().toISOString();
const predecessor = 'RBT12100LFP-M-G1-SA';
const successor = 'RBT12100LFP-M-G2-SA';
const victronOld = 'PMP482305010';
const victronNew = 'PMP482305012';
const pair = { predecessorSku: predecessor, successorSku: successor, sourceDescription: 'Synthetic explicit administrator confirmation' };
const discount = { renogy: 30, victron: 30 };
const user = { id: 7, role: 'customer', discounts: discount, xeroContactId: 'fixture-contact' };
let sourceQuote = { Contact: { ContactID: user.xeroContactId }, QuoteNumber: 'Fixture-Q', LineItems: [{ ItemCode: predecessor, Quantity: 2 }] };
const unexpectedNetwork = () => { throw new Error('No supplier, Hub, email or other external requests are permitted in this test.'); };
const originalFetch = globalThis.fetch;
globalThis.fetch = unexpectedNetwork;

// Compile the actual TS entry points, preserving their real SQL and shared
// helpers. An unexpected dependency fails instead of silently becoming a mock.
const moduleMap = {
  'node:fs': fs, 'node:path': path,
  'next/server': { NextResponse: Response },
  '@/lib/db': { __esModule: true, default: pool },
  '@/lib/catalogue-filters.mjs': catalogueFilters,
  '@/lib/data-freshness.mjs': freshness,
  '@/lib/sku-successions.mjs': successions,
  '@/lib/catalogue-succession.mjs': catalogueSuccession,
  '@/lib/favourite-products.mjs': favourites,
  './catalogue-export.mjs': catalogueExport,
  '@/lib/auth/server': { currentUser: async () => user },
};
function loadTs(relativePath, extraModules = {}) {
  const source = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  const modules = { ...moduleMap, ...extraModules };
  vm.runInNewContext(compiled, {
    exports, require: name => { assert.ok(name in modules, `Unexpected import ${name}`); return modules[name]; },
    process: { env: { NODE_ENV: 'production', PORTAL_BASE_URL: 'https://store.example.test' }, cwd: () => process.cwd() },
    Request, Response, URL, Date, Set, Map, JSON, Error, console, fetch: unexpectedNetwork,
  });
  return exports;
}
const catalogue = loadTs('../src/lib/catalogue.ts');
moduleMap['@/lib/catalogue'] = catalogue;
const fulfilment = loadTs('../src/lib/victron-fulfilment.ts');
moduleMap['@/lib/victron-fulfilment'] = fulfilment;
const cartRoute = loadTs('../src/app/api/cart/route.ts');
const favouritesRoute = loadTs('../src/app/api/favourites/route.ts');
const exportsApi = loadTs('../src/lib/commerce/catalogue-api.ts', {
  '@/lib/catalogue-classification.mjs': await import('../src/lib/catalogue-classification.mjs'),
});
const copyRoute = loadTs('../src/app/api/account/quotes/[quoteId]/copy/route.ts', {
  '@/lib/xero/customer-accounts': { customerDocument: async () => ({ payload: sourceQuote }), auditAccountAction: async () => {} },
  '@/lib/xero/oauth': { xeroAccountingFetch: unexpectedNetwork },
  '@/lib/commerce/quote-requests.mjs': { QuoteRequestLimitError: class extends Error {} },
  '@/lib/quote-settings': {},
});
const ids = new Map();
async function insertProduct(supplier, sku, stock, details = {}, price = 100, image = '') {
  const result = await pool.query(`INSERT INTO products(supplier,sku,name,category,price,image_url,stock_on_hand,details)
    VALUES($1,$2,$3,'Battery',$4,$5,$6,$7) RETURNING id`,
  [supplier, sku, `${supplier} 12.8V 100Ah Battery ${sku}`, price, image, stock, JSON.stringify(details)]);
  const id = Number(result.rows[0].id);
  ids.set(`${supplier}:${sku}`, id);
  return id;
}
const id = (supplier, sku) => ids.get(`${supplier}:${sku}`);
const productsSnapshot = async () => (await pool.query('SELECT * FROM products ORDER BY id')).rows;
const historySnapshot = async () => (await pool.query('SELECT * FROM xero_sales_invoice_lines ORDER BY invoice_id,sku')).rows;
const successionSnapshot = async () => (await pool.query('SELECT predecessor_sku,successor_sku,source_description FROM renogy_sku_successions ORDER BY predecessor_sku')).rows;
const renogyProducts = async options => (await catalogue.currentCatalogue(discount, options)).filter(product => product.supplier === 'renogy');
const findRenogy = (products, sku) => products.find(product => product.sku === sku);
const cartPost = (productId, quantity) => cartRoute.POST(new Request('https://store.example.test/api/cart', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId, quantity }),
}));
const updateDetails = (sku, details) => pool.query("UPDATE products SET details=details || $2::jsonb WHERE supplier='renogy' AND sku=$1", [sku, JSON.stringify(details)]);

try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await ensureProductSchema(pool);
  await successionAdmin.ensureRenogySkuSuccessionSchema(pool);
  await successionAdmin.ensureRenogySkuSuccessionSchema(pool);
  await pool.query(`CREATE TABLE portal_cart_lines (
    user_id BIGINT,product_id BIGINT REFERENCES products(id),quantity INTEGER,
    created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now(),PRIMARY KEY(user_id,product_id));
    CREATE TABLE contact_supplier_discounts(contact_id TEXT,supplier TEXT,discount_percent NUMERIC,updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE xero_sales_invoice_lines(invoice_id TEXT,sku TEXT,invoice_date DATE,quantity NUMERIC,contact_id TEXT);
    INSERT INTO contact_supplier_discounts(contact_id,supplier,discount_percent) VALUES('fixture-contact','renogy',30),('fixture-contact','victron',30);`);
  await insertProduct('renogy', predecessor, 16, { recommendedRetailExVat: 6462, description: 'Original G1 description', technicalData: { generation: 'G1' } }, 3877.20, 'https://example.test/original-photo.jpg');
  await insertProduct('renogy', successor, 0, { recommendedRetailExVat: 10000, supplierObservedAt: observedAt, technicalData: { generation: 'G2' } }, 5000);
  for (const sku of ['RNG-OTHER', 'RNG-A', 'RNG-B', 'RNG-C', 'RNG-D', 'RNG-ARTICLE', 'RNG-ARTICLE-R']) {
    await insertProduct('renogy', sku, 0, { recommendedRetailExVat: 100, supplierObservedAt: observedAt });
  }
  await insertProduct('renogy', 'RNG-HIDDEN', 0, { hidden: true });
  await insertProduct('victron', 'VICTRON-ONLY', 0);
  await insertProduct('victron', victronOld, 0, { recommendedRetailExVat: 500, supplierObservedAt: observedAt });
  await insertProduct('victron', victronNew, 5, { recommendedRetailExVat: 1000, supplierObservedAt: observedAt });
  await pool.query('INSERT INTO victron_sku_successions(predecessor_sku,successor_sku,source_description) VALUES($1,$2,$3)', [victronOld, victronNew, `If 0, order ${victronNew}`]);
  await pool.query(`INSERT INTO portal_cart_lines(user_id,product_id,quantity) VALUES($1,$2,2);
  `, [user.id, id('renogy', predecessor)]);
  await pool.query(`INSERT INTO xero_sales_invoice_lines(invoice_id,sku,invoice_date,quantity,contact_id)
    VALUES('invoice-renogy',$1,current_date,7,$3),('invoice-victron',$2,current_date,3,$3),('invoice-victron-r',$4,current_date,2,$3)`,
  [predecessor, victronOld, user.xeroContactId, `${victronOld}R`]);
  const originalProducts = await productsSnapshot();
  const originalHistory = await historySnapshot();
  const victronBefore = (await pool.query('SELECT * FROM victron_sku_successions')).rows;

  // G-number similarities do not establish a relationship. Old raw 16 has no
  // source observation and must stay unknown; the current supplier zero is zero.
  let products = await renogyProducts();
  assert.equal(findRenogy(products, predecessor).stock_on_hand, null);
  assert.equal(findRenogy(products, successor).stock_on_hand, 0);
  assert.ok(findRenogy(products, predecessor));
  assert.equal((await fulfilment.resolveFulfilmentProduct(id('renogy', predecessor))).sku, predecessor);
  await successionAdmin.saveRenogySkuSuccession(pool, { ...pair, predecessorSku: ` ${predecessor.toLowerCase()} ` });
  await successionAdmin.saveRenogySkuSuccession(pool, pair);
  assert.equal((await successionSnapshot()).length, 1, 'repeated confirmation is idempotent');
  assert.deepEqual(await productsSnapshot(), originalProducts, 'linking must not rewrite stock, prices, descriptions or product identity');
  assert.deepEqual(await historySnapshot(), originalHistory, 'historic invoice lines retain the literal original article codes');

  for (const invalid of [
    { ...pair, successorSku: 'VICTRON-ONLY' }, { ...pair, successorSku: 'NOT-IN-CATALOGUE' },
    { ...pair, successorSku: predecessor }, { ...pair, successorSku: 'RNG-HIDDEN' },
    { ...pair, predecessorSku: '' },
  ]) await assert.rejects(() => successionAdmin.saveRenogySkuSuccession(pool, invalid), error => error.status === 400);
  await assert.rejects(() => successionAdmin.saveRenogySkuSuccession(pool, { ...pair, successorSku: 'RNG-OTHER' }), error => error.status === 409);
  await assert.rejects(() => successionAdmin.saveRenogySkuSuccession(pool, { predecessorSku: successor, successorSku: predecessor }), error => error.status === 409);
  assert.deepEqual((await successionSnapshot()).map(row => [row.predecessor_sku, row.successor_sku]), [[predecessor, successor]]);
  const race = await Promise.allSettled([
    successionAdmin.saveRenogySkuSuccession(pool, { predecessorSku: 'RNG-A', successorSku: 'RNG-B' }),
    successionAdmin.saveRenogySkuSuccession(pool, { predecessorSku: 'RNG-B', successorSku: 'RNG-A' }),
  ]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1, 'concurrent opposite links cannot commit a cycle');
  assert.equal(race.find(result => result.status === 'rejected').reason.status, 409);
  const racePair = (await successionSnapshot()).find(row => row.predecessor_sku !== predecessor);
  await successionAdmin.removeRenogySkuSuccession(pool, { predecessorSku: racePair.predecessor_sku, successorSku: racePair.successor_sku });

  // Discovery, old-code search, favourite history and a historic quote all point
  // at the explicit current article. None borrow the old article's quantity.
  products = await renogyProducts();
  assert.equal(findRenogy(products, predecessor), undefined);
  const replacement = findRenogy(products, successor);
  assert.equal(replacement.stock_on_hand, 0);
  assert.equal(replacement.your_price_ex_vat, 7000);
  assert.equal(catalogueFilters.productAvailability(replacement)[0], 'unavailable');
  assert.ok(catalogueSuccession.catalogueProductMatchesQuery(replacement, predecessor));
  assert.ok(replacement.details.replaces.includes(predecessor));
  assert.equal(replacement.image_url, 'https://example.test/original-photo.jpg');
  let resolved = await fulfilment.resolveFulfilmentProduct(id('renogy', predecessor));
  assert.equal(resolved.sku, successor); assert.equal(resolved.hasStock, false); assert.equal(resolved.substituted, true);
  assert.equal((await cartPost(id('renogy', predecessor), 1)).status, 409, 'old unobserved 16 cannot make an out-of-stock replacement orderable');
  let cart = await (await cartRoute.GET()).json();
  assert.equal(cart.lines[0].product.sku, predecessor);
  assert.equal(cart.lines[0].product.stock_on_hand, null);
  assert.equal(cart.lines[0].quantity, 2);
  const favouriteResult = await (await favouritesRoute.GET()).json();
  assert.ok(favouriteResult.mine.some(product => product.supplier === 'renogy' && product.sku === successor));
  assert.equal(favouriteResult.mine.filter(product => product.supplier === 'renogy').length, 1);
  assert.ok(favouriteResult.mine.some(product => product.supplier === 'victron' && product.sku === victronNew));
  const copied = await (await copyRoute.GET(new Request('https://store.example.test/api/account/quotes/source/copy'), { params: Promise.resolve({ quoteId: 'source' }) })).json();
  assert.equal(copied.lines[0].sku, successor); assert.equal(copied.lines[0].unitPrice, 7000); assert.equal(copied.lines[0].quantity, 2);
  let exported = await (await exportsApi.catalogueExport(new Request('https://store.example.test/api/catalogue'), user.xeroContactId)).json();
  assert.equal(exported.data.find(product => product.sku === predecessor), undefined);
  assert.equal(exported.data.find(product => product.sku === successor).supplier_stock, 0);

  // Independently observed old stock remains saleable using its own SKU and
  // price. A successor request can fulfil the old stock as in the Victron flow.
  await updateDetails(predecessor, { localStockOnHand: 2, xeroStockStatus: 'tracked', xeroStockSyncedAt: observedAt });
  products = await renogyProducts();
  assert.equal(findRenogy(products, predecessor).details.localStockOnHand, 2);
  assert.equal(findRenogy(products, predecessor).stock_on_hand, null);
  resolved = await fulfilment.resolveFulfilmentProduct(id('renogy', successor));
  assert.equal(resolved.sku, predecessor); assert.equal(resolved.hasStock, true);
  cart = await (await cartPost(id('renogy', successor), 1)).json();
  assert.equal(cart.lines.length, 1); assert.equal(cart.lines[0].product.sku, predecessor); assert.equal(cart.lines[0].quantity, 3);
  assert.equal(cart.lines[0].product.your_price_ex_vat, 4523.4);
  exported = await (await exportsApi.catalogueExport(new Request('https://store.example.test/api/catalogue'), user.xeroContactId)).json();
  assert.equal(exported.data.find(product => product.sku === predecessor).successor_sku, successor);
  const csv = await (await exportsApi.catalogueExport(new Request('https://store.example.test/api/catalogue?format=csv'), user.xeroContactId)).text();
  assert.ok(csv.includes(`"${predecessor}"`)); assert.ok(csv.includes(`"${successor}"`));

  await updateDetails(predecessor, { localStockOnHand: 0 });
  await pool.query("UPDATE products SET stock_on_hand=3 WHERE supplier='renogy' AND sku=$1", [successor]);
  resolved = await fulfilment.resolveFulfilmentProduct(id('renogy', predecessor));
  assert.equal(resolved.sku, successor); assert.equal(resolved.hasStock, true);
  cart = await (await cartPost(id('renogy', predecessor), 4)).json();
  assert.equal(cart.lines.find(line => line.product.sku === successor).quantity, 4);
  assert.equal(cart.lines.find(line => line.product.sku === successor).product.your_price_ex_vat, 7000);
  assert.equal((await pool.query("SELECT stock_on_hand FROM products WHERE supplier='renogy' AND sku=$1", [predecessor])).rows[0].stock_on_hand, 16);
  assert.equal((await pool.query("SELECT stock_on_hand FROM products WHERE supplier='renogy' AND sku=$1", [successor])).rows[0].stock_on_hand, 3);
  assert.deepEqual(await historySnapshot(), originalHistory);

  // Brand isolation and Victron's retail alias rule survive the shared resolver.
  resolved = await fulfilment.resolveFulfilmentProduct(id('renogy', 'RNG-ARTICLE-R'));
  assert.equal(resolved.sku, 'RNG-ARTICLE-R'); assert.equal(resolved.substituted, false);
  resolved = await fulfilment.resolveFulfilmentProduct(id('victron', victronOld));
  assert.equal(resolved.sku, victronNew); assert.equal(resolved.hasStock, true);
  assert.deepEqual((await pool.query('SELECT * FROM victron_sku_successions')).rows, victronBefore);
  const loaded = await successions.loadSkuSuccessions(pool);
  assert.notEqual(successions.skuFamilyResolver(loaded)('renogy', 'RNG-ARTICLE-R'), successions.skuFamilyResolver(loaded)('renogy', 'RNG-ARTICLE'));
  assert.equal(successions.skuFamilyResolver(loaded)('victron', `${victronOld}R`), successions.skuFamilyResolver(loaded)('victron', victronNew));

  // Removal reverses discovery only. Quantities, cart entries and historic
  // invoices remain exactly as they were immediately before removing the link.
  const beforeRemove = await productsSnapshot();
  const beforeCart = (await pool.query('SELECT * FROM portal_cart_lines ORDER BY product_id')).rows;
  await assert.rejects(() => successionAdmin.removeRenogySkuSuccession(pool, { ...pair, successorSku: 'RNG-OTHER' }), error => error.status === 404);
  await successionAdmin.removeRenogySkuSuccession(pool, pair);
  assert.equal((await successionSnapshot()).length, 0);
  assert.ok(findRenogy(await renogyProducts(), predecessor));
  assert.deepEqual(await productsSnapshot(), beforeRemove);
  assert.deepEqual((await pool.query('SELECT * FROM portal_cart_lines ORDER BY product_id')).rows, beforeCart);
  assert.deepEqual(await historySnapshot(), originalHistory);
  assert.deepEqual((await pool.query('SELECT * FROM victron_sku_successions')).rows, victronBefore);
  console.log('PASS: explicit Renogy linking/validation/concurrency; unknown versus zero; discovery/search, favourites, quote copy, cart and exports; per-SKU quantities/prices/history; reversible links and unchanged Victron aliases.');
} finally {
  globalThis.fetch = originalFetch;
  await pool.end();
  try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await admin.end(); }
}
