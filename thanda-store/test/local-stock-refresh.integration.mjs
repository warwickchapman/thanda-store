// Real cached-Hub stock worker, disposable local PostgreSQL and fake HTTP only.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ensureProductSchema } from '../scripts/product-sync-lib.mjs';
import { requestLocalStockRefresh } from '../src/lib/local-stock-refresh.mjs';

if (process.env.RUN_LOCAL_STOCK_REFRESH_DB_TESTS !== '1' || !process.env.DATABASE_URL) {
  throw new Error('Set RUN_LOCAL_STOCK_REFRESH_DB_TESTS=1 with a local disposable DATABASE_URL.');
}
const database = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)) throw new Error('Only local disposable PostgreSQL is allowed.');
const schema = `local_stock_refresh_test_${crypto.randomBytes(6).toString('hex')}`;
const admin = new pg.Pool({ connectionString: database.toString(), connectionTimeoutMillis: 5000 });
database.searchParams.set('options', `-c search_path=${schema}`);
const pool = new pg.Pool({ connectionString: database.toString(), connectionTimeoutMillis: 5000 });
const token = 'synthetic-local-stock-refresh-token';
const calls = [], errors = [];
let observedAt = new Date().toISOString();
let failItems = false;
let beforeItemsResponse = null;
let revision = 0;
const server = http.createServer(async (request, response) => {
  try {
    calls.push(request.url);
    assert.equal(request.method, 'GET', 'The importer may only read the cached Hub.');
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/thanda-solar/status') {
      response.end(JSON.stringify({ tenant_id: 'synthetic-thanda-tenant' })); return;
    }
    assert.equal(request.url, '/v1/thanda-solar/accounting/Items');
    if (beforeItemsResponse) {
      const action = beforeItemsResponse;
      beforeItemsResponse = null;
      await action();
    }
    if (failItems) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: 'Synthetic cached collection unavailable' })); return;
    }
    response.end(JSON.stringify({ _hub: { company: 'thanda-solar', complete: true,
      observed_at: observedAt, snapshot: `local-stock-revision-${++revision}` }, Items: [
      { ItemID: 'synthetic-multiplus-item', Code: 'PMP482305012', Name: 'Victron MultiPlus',
        IsTrackedAsInventory: true, QuantityOnHand: 7 },
    ] }));
  } catch (error) {
    errors.push(error);
    response.statusCode = 500;
    response.end(JSON.stringify({ error: 'Synthetic handler assertion failed' }));
  }
});

async function run({ expectedExit = 0, expectedCalls = 2 } = {}) {
  const count = calls.length;
  const child = spawn(process.execPath, ['scripts/sync-xero-stock.mjs', '--if-requested'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    // Never inherit production credentials, supplier URLs or database settings.
    env: { PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC', NODE_ENV: 'test',
      DATABASE_URL: database.toString(), XERO_HUB_URL: `http://127.0.0.1:${server.address().port}`, XERO_HUB_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); }
  finally { clearTimeout(timeout); }
  assert.equal(code, expectedExit, output);
  assert.equal(errors.length, 0, errors.map(error => error.message).join('\n'));
  assert.equal(calls.length - count, expectedCalls, 'Only the existing cached status/Items reads are allowed.');
  assert.ok(!output.includes(token), 'No authentication token may be logged.');
}
const state = async () => (await pool.query('SELECT refresh_requested_at::text AS requested_at FROM xero_stock_sync_state WHERE id=true')).rows[0];

try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await ensureProductSchema(pool);
  await pool.query("INSERT INTO products(sku,supplier,name) VALUES('PMP482305012','victron','Victron MultiPlus')");
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await run({ expectedCalls: 0 });

  await requestLocalStockRefresh(pool, { afterChange: true });
  // Make the timestamp intentionally more precise than JS Date. Consuming a
  // request must compare its original PostgreSQL value, not millisecond text.
  await pool.query("UPDATE xero_stock_sync_state SET refresh_requested_at=date_trunc('milliseconds',refresh_requested_at)+interval '123 microseconds'");
  const initial = (await state()).requested_at;
  await requestLocalStockRefresh(pool);
  assert.equal((await state()).requested_at, initial, 'ordinary page visits coalesce the pending request');
  observedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  await run();
  assert.equal((await state()).requested_at, initial, 'an older complete Hub snapshot cannot satisfy a newer request');
  assert.equal((await pool.query("SELECT details->'localStockOnHand' AS quantity FROM products")).rows[0].quantity, 7);

  observedAt = new Date(Date.now() + 1000).toISOString();
  await run();
  assert.equal((await state()).requested_at, null, 'a sufficiently recent complete import consumes exactly the captured request');
  await run({ expectedCalls: 0 });

  await requestLocalStockRefresh(pool, { afterChange: true });
  const captured = (await state()).requested_at;
  let newer;
  beforeItemsResponse = async () => {
    await requestLocalStockRefresh(pool, { afterChange: true });
    newer = (await state()).requested_at;
    assert.notEqual(newer, captured);
    observedAt = new Date(Date.now() + 2000).toISOString();
  };
  await run();
  assert.equal((await state()).requested_at, newer, 'a newer catalogue change arriving during the worker is not lost');
  observedAt = new Date(Date.now() + 3000).toISOString();
  await run();
  assert.equal((await state()).requested_at, null);

  await requestLocalStockRefresh(pool, { afterChange: true });
  const beforeFailure = (await state()).requested_at;
  failItems = true;
  await run({ expectedExit: 1 });
  assert.equal((await state()).requested_at, beforeFailure, 'a failed import preserves queued work');
  assert.equal((await pool.query("SELECT details->'localStockOnHand' AS quantity FROM products")).rows[0].quantity, 7);
  assert.equal((await pool.query("SELECT last_status FROM data_sync_status WHERE source_id='thanda'")).rows[0].last_status, 'failed');
  console.log('PASS: real local-stock worker preserves request precision, old-snapshot work, newer concurrent requests, failed work and real stock. Fake cached Hub only.');
} finally {
  await new Promise(resolve => server.close(resolve));
  await pool.end();
  try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
  finally { await admin.end(); }
}
