// Real sync job, disposable local PostgreSQL and a fake Renogy HTTP server.
// No supplier credentials or external provider requests are used.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ensureProductSchema } from '../scripts/product-sync-lib.mjs';
import { supplierStockObservation } from '../src/lib/data-freshness.mjs';

if (process.env.RUN_RENOGY_STOCK_DB_TESTS !== '1' || !process.env.DATABASE_URL) {
  throw new Error('Set RUN_RENOGY_STOCK_DB_TESTS=1 and a local disposable DATABASE_URL.');
}
const url = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use a local disposable database.');
const schema = `renogy_stock_test_${crypto.randomBytes(6).toString('hex')}`;
const root = new pg.Pool({ connectionString: url.toString() });
url.searchParams.set('options', `-c search_path=${schema}`);
const pool = new pg.Pool({ connectionString: url.toString() });
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'renogy-stock-test-'));
const tokenFile = path.join(directory, 'token.json');
const csvFile = path.join(directory, 'warehouse.csv');
const token = 'synthetic-renogy-stock-test-token';
const prefix = '/prod-api/api/sc/portal';
const fixtures = [
  { id: 'positive', sku: 'RNG-STOCK-POSITIVE', exported: 28, availble: 28, inventory: 0 },
  { id: 'zero', sku: 'RNG-STOCK-ZERO', exported: 99, availble: 0, inventory: 99 },
  { id: 'fallback', sku: 'RNG-STOCK-FALLBACK', exported: 7, inventory: 450 },
];
const bySku = new Map(fixtures.map(fixture => [fixture.sku, fixture]));
const byId = new Map(fixtures.map(fixture => [fixture.id, fixture]));
const calls = [], handlerErrors = [];
let exportDownloadedAt = null;
let exportOverride = null;
let exportHttpStatus = 200;
let missingSearchSku = null;
let failedDetailSku = null;
const server = http.createServer(async (request, response) => {
  try {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : null;
    const endpoint = new URL(request.url, `http://${request.headers.host}`);
    calls.push({ method: request.method, path: endpoint.pathname, body });
    response.setHeader('Content-Type', 'application/json');
    const send = data => response.end(JSON.stringify({ code: 200, data }));
    if (endpoint.pathname === '/download/stock.csv') {
      assert.equal(request.method, 'GET');
      if (exportHttpStatus !== 200) {
        response.statusCode = exportHttpStatus;
        response.end('Synthetic export download failed');
        return;
      }
      exportDownloadedAt = Date.now();
      response.setHeader('Content-Type', 'text/csv');
      response.end(exportOverride ?? ['Item No,Item Description,Available,In transit,Expected Delivery Date',
        ...fixtures.map(fixture => `${fixture.sku},Fixture battery ${fixture.id},${fixture.exported},0,`)].join('\n'));
      return;
    }
    assert.equal(request.headers.authorization, token, 'Only the synthetic cached token should be sent.');
    if (endpoint.pathname === `${prefix}/user/info`) {
      assert.equal(request.method, 'GET'); send({ id: 'synthetic-stock-contact' }); return;
    }
    if (endpoint.pathname === '/prod-api/api/pp/report/item/export') {
      assert.equal(request.method, 'POST'); assert.deepEqual(body, { contactId: 'synthetic-stock-contact' });
      send({ fileName: 'stock.csv' }); return;
    }
    if (endpoint.pathname === `${prefix}/common/file/preSignedUrl`) {
      assert.equal(request.method, 'GET'); assert.equal(endpoint.searchParams.get('fileName'), '');
      send({ url: `http://127.0.0.1:${server.address().port}/download/` }); return;
    }
    if (endpoint.pathname === `${prefix}/item/listPage`) {
      assert.equal(request.method, 'POST');
      const fixture = bySku.get(body.productSearch);
      assert.ok(fixture, 'The job must search only products from the selected source.');
      if (fixture.sku === missingSearchSku) { send({ rows: [] }); return; }
      send({ rows: [{ id: fixture.id, data: { id: fixture.sku, inventory: 9999, amount: 100, item_view_type: 'Battery' } }] }); return;
    }
    if (endpoint.pathname.startsWith(`${prefix}/item/`)) {
      assert.equal(request.method, 'GET');
      const fixture = byId.get(endpoint.pathname.slice(`${prefix}/item/`.length));
      assert.ok(fixture);
      if (fixture.sku === failedDetailSku) {
        response.statusCode = 500;
        response.end(JSON.stringify({ code: 500, msg: 'Synthetic detail unavailable' }));
        return;
      }
      send({ data: {
        item_view_title: `Fixture 12.8V 100Ah battery ${fixture.id}`, item_view_type: 'Battery',
        inventory: fixture.inventory,
        ...(Object.hasOwn(fixture, 'availble') ? { availble: fixture.availble } : {}),
        available_overseas: 6000, safety_inventory: 7000, safety_remaining: 8000,
        originalPrice: 500, unitPrice: 300,
      } }); return;
    }
    assert.fail(`Unexpected request ${request.method} ${endpoint.pathname}`);
  } catch (error) {
    handlerErrors.push(error);
    response.statusCode = 500;
    response.end(JSON.stringify({ code: 500, msg: 'Synthetic handler assertion failed' }));
  }
});

async function run(source, expectedExit = 0) {
  const child = spawn(process.execPath, ['scripts/sync-renogy-products.mjs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    // Deliberately avoid inheriting production provider/database environment.
    env: {
      PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC', NODE_ENV: 'test',
      DATABASE_URL: url.toString(), RENOGY_BASE_URL: `http://127.0.0.1:${server.address().port}${prefix}`,
      RENOGY_TOKEN_CACHE_FILE: tokenFile, RENOGY_PRODUCT_SOURCE: source,
      RENOGY_REQUEST_TIMEOUT_MS: '3000', WAREHOUSE_CSV: csvFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  } finally { clearTimeout(timeout); }
  assert.equal(handlerErrors.length, 0, handlerErrors.map(error => error.message).join('\n'));
  assert.equal(code, expectedExit, output);
  assert.ok(!output.includes(token), 'Even synthetic authentication tokens must not be logged.');
  return expectedExit === 0 ? JSON.parse(output.trim()) : output;
}
const products = async () => (await pool.query("SELECT * FROM products WHERE supplier='renogy' ORDER BY sku")).rows;
const observedDuring = (value, start, end) => {
  assert.equal(typeof value, 'string');
  const timestamp = Date.parse(value);
  assert.ok(Number.isFinite(timestamp) && timestamp >= start && timestamp <= end, `Source observation ${value} must belong to this job.`);
};

try {
  await root.query(`CREATE SCHEMA ${schema}`);
  await ensureProductSchema(pool);
  const previousObservedAt = '2026-01-01T00:00:00.000Z';
  // Correct existing cached rows, retaining their identities rather than
  // creating duplicates while the actual sync replaces the wrong quantities.
  for (const [index, fixture] of fixtures.slice(0, 2).entries()) {
    await pool.query(`INSERT INTO products(supplier,sku,name,stock_on_hand,details)
      VALUES('renogy',$1,$2,$3,$4)`, [fixture.sku, `Previously cached ${fixture.id}`, index === 0 ? 0 : 99,
    JSON.stringify({ supplierObservedAt: previousObservedAt, supplierStockStatus: 'known' })]);
  }
  const removedDetails = { supplierObservedAt: previousObservedAt, supplierStockStatus: 'known',
    localStockOnHand: 2, xeroStockStatus: 'tracked', xeroStockSyncedAt: previousObservedAt,
    hidden: true, description: 'Keep editorial content', imageSource: 'manual' };
  await pool.query(`INSERT INTO products(supplier,sku,name,stock_on_hand,image_url,details)
    VALUES('renogy','RNG-REMOVED','Previously listed article',7,'/manual-photo.webp',$1)`, [JSON.stringify(removedDetails)]);
  const removedBefore = (await products()).find(product => product.sku === 'RNG-REMOVED');
  const originalIds = new Map((await products()).map(product => [product.sku, product.id]));
  await fs.writeFile(tokenFile, JSON.stringify({ token }), { mode: 0o600 });
  await fs.writeFile(csvFile, 'SKU,Description,Stock\nRNG-STOCK-FALLBACK,Locally saved fixture battery,11\n');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  const started = Date.now();
  const result = await run('export');
  const completed = Date.now();
  assert.equal(result.total, 3); assert.equal(result.synced, 3);
  assert.deepEqual(result.failed, []); assert.deepEqual(result.notFound, []);
  assert.equal(calls.length, 10, 'Exactly four shared export/identity requests plus search/detail per SKU; no extra API probes.');
  assert.deepEqual(calls.slice(0, 4).map(call => call.path), [
    `${prefix}/user/info`, '/prod-api/api/pp/report/item/export', `${prefix}/common/file/preSignedUrl`, '/download/stock.csv',
  ]);
  assert.equal(calls.filter(call => call.path.endsWith('/item/listPage')).length, 3);
  assert.equal(calls.filter(call => call.path.startsWith(`${prefix}/item/`) && call.method === 'GET').length, 3);
  assert.ok(!calls.some(call => call.path.includes('prelogin')), 'A valid cached identity does not need another login.');
  let rows = await products();
  assert.equal(rows.length, 4);
  const positive = rows.find(product => product.sku === fixtures[0].sku);
  const zero = rows.find(product => product.sku === fixtures[1].sku);
  const fallback = rows.find(product => product.sku === fixtures[2].sku);
  const removed = rows.find(product => product.sku === 'RNG-REMOVED');
  assert.deepEqual(result.catalogue, { listed: 3, absent: 1 });
  assert.equal(removed.details.cataloguePresent, false);
  observedDuring(removed.details.catalogueObservedAt, exportDownloadedAt, completed);
  const retainedDetails = { ...removed.details };
  delete retainedDetails.cataloguePresent;
  delete retainedDetails.catalogueObservedAt;
  assert.deepEqual(retainedDetails, removedDetails, 'Absence must not fabricate zero, hide, rewrite content or freshen stock.');
  assert.deepEqual({ ...removed, details: retainedDetails }, removedBefore, 'Only catalogue membership metadata changes.');
  assert.equal(positive.id, originalIds.get(positive.sku)); assert.equal(zero.id, originalIds.get(zero.sku));
  assert.equal(positive.stock_on_hand, 28, 'Portal availble=28 wins over raw inventory=0.');
  assert.equal(zero.stock_on_hand, 0, 'Portal availble=0 is a known zero, never replaced by raw/export inventory=99.');
  assert.equal(fallback.stock_on_hand, 7, 'Without availble, use the freshly observed export Available field.');
  for (const product of [positive, zero]) {
    assert.equal(product.details.cataloguePresent, true);
    observedDuring(product.details.catalogueObservedAt, exportDownloadedAt, completed);
    assert.equal(product.details.supplierStockSource, 'renogy-detail.availble');
    assert.equal(product.details.supplierStockStatus, 'known');
    observedDuring(product.details.supplierObservedAt, started, completed);
    assert.equal(supplierStockObservation(product).quantity, product.stock_on_hand);
  }
  assert.equal(fallback.details.supplierStockSource, 'renogy-export.Available');
  assert.equal(fallback.details.supplierStockStatus, 'known');
  observedDuring(fallback.details.supplierObservedAt, exportDownloadedAt, completed);
  assert.equal(supplierStockObservation(fallback).quantity, 7);
  assert.equal(positive.details.availableOverseas, 6000);
  assert.equal(positive.details.safetyInventory, 7000);
  assert.equal(zero.details.productListStock, 99, 'Source export quantity is retained for audit, not used as the current zero quantity.');
  const status = (await pool.query("SELECT last_status,last_counts FROM data_sync_status WHERE source_id='renogy'")).rows[0];
  assert.equal(status.last_status, 'success');
  assert.equal(status.last_counts.synced, 3);
  assert.equal(status.last_counts.catalogueListed, 3);
  assert.equal(status.last_counts.catalogueAbsent, 1);

  // Incomplete/malformed downloads cannot change retained membership or stock.
  const beforeBadExport = await products();
  exportHttpStatus = 503;
  await run('export', 1);
  assert.deepEqual(await products(), beforeBadExport);
  exportHttpStatus = 200;
  for (const invalid of ['', 'Item No,Item Description,Available\n',
    'Item No,Item Description,Available\nRNG-A,One,0\nrng-a,Duplicate,0',
    '<html>Supplier unavailable</html>']) {
    exportOverride = invalid;
    await run('export', 1);
    assert.deepEqual(await products(), beforeBadExport);
  }
  exportOverride = null;

  // Complete export membership is independent of a subsequent search/detail
  // failure. A returning article becomes listed without any invented zero.
  missingSearchSku = fixtures[0].sku;
  const missingSearch = await run('export');
  assert.deepEqual(missingSearch.notFound, [missingSearchSku]);
  let retained = (await products()).find(product => product.sku === missingSearchSku);
  assert.equal(retained.details.cataloguePresent, true);
  assert.equal(retained.details.supplierObservedAt, positive.details.supplierObservedAt);
  assert.equal(retained.stock_on_hand, positive.stock_on_hand);
  missingSearchSku = null;
  const returning = { id: 'returning', sku: 'RNG-REMOVED', exported: 7, availble: 7, inventory: 0 };
  fixtures.push(returning); bySku.set(returning.sku, returning); byId.set(returning.id, returning);
  failedDetailSku = fixtures[1].sku;
  const beforeFailedDetail = (await products()).find(product => product.sku === failedDetailSku);
  const partial = JSON.parse(await run('export', 1));
  assert.deepEqual(partial.catalogue, { listed: 4, absent: 0 });
  assert.equal(partial.failed.length, 1);
  rows = await products();
  assert.equal(rows.find(product => product.sku === returning.sku).details.cataloguePresent, true);
  retained = rows.find(product => product.sku === failedDetailSku);
  assert.equal(retained.details.cataloguePresent, true);
  assert.equal(retained.details.supplierObservedAt, beforeFailedDetail.details.supplierObservedAt, 'A failed stock refresh must retain its real source observation.');
  failedDetailSku = null;

  // Re-reading a local file must clear the previous fresh export observation.
  // The raw legacy number remains auditable, but the customer sees unknown age.
  const exportRows = rows;
  const beforeCsv = calls.length;
  const localResult = await run('csv');
  assert.equal(localResult.total, 1); assert.equal(localResult.synced, 1); assert.deepEqual(localResult.failed, []);
  assert.equal(calls.length - beforeCsv, 3, 'CSV source uses identity, one search and one detail; no export or stock-specific request.');
  rows = await products();
  const localFallback = rows.find(product => product.sku === fixtures[2].sku);
  assert.equal(localFallback.stock_on_hand, 11);
  assert.equal(localFallback.details.supplierStockSource, 'warehouse-csv.Stock');
  assert.equal(localFallback.details.supplierObservedAt, null, 'File read time must not become source-observed time.');
  assert.equal(localFallback.details.catalogueObservedAt, exportRows.find(product => product.sku === localFallback.sku).details.catalogueObservedAt,
    'Local CSV does not establish new supplier membership.');
  assert.equal(supplierStockObservation(localFallback).quantity, null);
  assert.deepEqual(rows.filter(product => product.sku !== fixtures[2].sku), exportRows.filter(product => product.sku !== fixtures[2].sku));
  console.log('PASS: real Renogy sync preserves stock provenance, records complete export membership, retains invalid-export evidence and absent-product stock/content, handles returning articles and partial detail failures, and stays within 4+2N export requests. No live provider calls.');
} finally {
  await new Promise(resolve => server.close(() => resolve()));
  await fs.rm(directory, { recursive: true, force: true });
  await pool.end();
  try { await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await root.end(); }
}
