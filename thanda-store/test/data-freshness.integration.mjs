// Opt-in, disposable schema and local fake Hub only. No supplier/Xero calls.
import pg from 'pg';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { ensureProductSchema } from '../scripts/product-sync-lib.mjs';
import { startDataSync, finishDataSync } from '../src/lib/data-sync-state.mjs';
import { localStockObservation } from '../src/lib/data-freshness.mjs';

if (process.env.RUN_FRESHNESS_DB_TESTS !== '1') throw new Error('Set RUN_FRESHNESS_DB_TESTS=1 with a disposable DATABASE_URL.');
const schema = `freshness_test_${crypto.randomBytes(6).toString('hex')}`;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const admin = new pg.Pool({ connectionString });
const scopedUrl = new URL(connectionString);
scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
const pool = new pg.Pool({ connectionString: scopedUrl.toString() });
const observedAt = '2026-09-20T08:00:00.000Z';
const creditObservedAt = '2026-09-20T07:00:00.000Z';
let failHub = false;
const calls = [];
const server = http.createServer((request, response) => {
  calls.push(request.url);
  response.setHeader('Content-Type', 'application/json');
  if (failHub) { response.statusCode = 503; response.end('{"error":"Synthetic outage"}'); return; }
  if (request.url.endsWith('/status')) {
    response.end(JSON.stringify({ tenant_id: 'synthetic-tenant', scope: 'accounting.invoices' })); return;
  }
  const meta = { complete: true, snapshot: 'synthetic', observed_at: observedAt };
  if (request.url.includes('/Items')) {
    response.end(JSON.stringify({ _hub: meta, Items: [
      { Code: 'KNOWN-ZERO', IsTrackedAsInventory: true, QuantityOnHand: 0 },
      { Code: 'UNTRACKED', IsTrackedAsInventory: false },
      { Code: 'INVALID-QTY', IsTrackedAsInventory: true, QuantityOnHand: null },
      { Code: 'LORA-RS-00120', IsTrackedAsInventory: true, QuantityOnHand: 4 },
    ] })); return;
  }
  if (request.url.includes('/CreditNotes')) {
    response.end(JSON.stringify({ _hub: { ...meta, observed_at: creditObservedAt }, CreditNotes: [] })); return;
  }
  if (request.url.includes('/Invoices')) { response.end(JSON.stringify({ _hub: meta, Invoices: [] })); return; }
  if (request.url.includes('/Quotes')) { response.end(JSON.stringify({ _hub: meta, Quotes: [] })); return; }
  response.statusCode = 404; response.end('{}');
});

async function runScript(script, expectedCode = 0) {
  const child = spawn(process.execPath, [`scripts/${script}`], {
    env: { ...process.env, DATABASE_URL: scopedUrl.toString(), XERO_HUB_URL: `http://127.0.0.1:${server.address().port}`, XERO_HUB_TOKEN: 'synthetic-test-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, expectedCode, output);
}

try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await ensureProductSchema(pool);
  await pool.query(`INSERT INTO products (sku,supplier,name) VALUES
    ('KNOWN-ZERO','victron','Known zero'), ('UNTRACKED','victron','Untracked'),
    ('MISSING','victron','Absent item'), ('INVALID-QTY','victron','Invalid quantity'),
    ('LORA-RS-00120','lora','LoRa')`);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await runScript('sync-xero-stock.mjs');
  const products = (await pool.query('SELECT sku,details FROM products ORDER BY sku')).rows;
  for (const product of products) {
    assert.equal(product.details.xeroStockSyncedAt, observedAt);
    const quantity = product.sku === 'KNOWN-ZERO' ? 0 : product.sku === 'LORA-RS-00120' ? 4 : null;
    assert.equal(product.details.localStockOnHand, quantity);
    assert.equal(localStockObservation(product).quantity, quantity);
  }
  let stockRun = (await pool.query("SELECT * FROM data_sync_status WHERE source_id='thanda'")).rows[0];
  assert.equal(stockRun.last_status, 'success');
  assert.equal(stockRun.source_observed_at.toISOString(), observedAt);
  assert.ok(stockRun.last_successful_at > stockRun.source_observed_at);

  await runScript('sync-xero-sales-history.mjs');
  const invoices = (await pool.query('SELECT * FROM xero_invoice_sync_state')).rows[0];
  const credits = (await pool.query('SELECT * FROM xero_credit_note_sync_state')).rows[0];
  assert.equal(invoices.source_observed_at.toISOString(), observedAt);
  assert.equal(credits.source_observed_at.toISOString(), creditObservedAt);
  const salesRun = (await pool.query("SELECT * FROM data_sync_status WHERE source_id='sales'")).rows[0];
  assert.equal(salesRun.source_observed_at.toISOString(), creditObservedAt);

  await runScript('sync-xero-accepted-quotes.mjs');
  const quoteRun = (await pool.query("SELECT * FROM data_sync_status WHERE source_id='accepted-quotes'")).rows[0];
  assert.equal(quoteRun.source_observed_at.toISOString(), observedAt);
  assert.ok(quoteRun.last_successful_at > quoteRun.source_observed_at);

  failHub = true;
  await runScript('sync-xero-stock.mjs', 1);
  stockRun = (await pool.query("SELECT * FROM data_sync_status WHERE source_id='thanda'")).rows[0];
  assert.equal(stockRun.last_status, 'failed');
  assert.equal(stockRun.source_observed_at.toISOString(), observedAt);
  assert.ok(stockRun.last_successful_at);
  await startDataSync(pool, 'thanda');
  assert.equal((await pool.query("SELECT last_status FROM data_sync_status WHERE source_id='thanda'")).rows[0].last_status, 'failed');
  await finishDataSync(pool, 'thanda', { status: 'partial', counts: { updated: 2, failed: 1 } });
  stockRun = (await pool.query("SELECT * FROM data_sync_status WHERE source_id='thanda'")).rows[0];
  assert.equal(stockRun.last_status, 'partial');
  assert.equal(stockRun.source_observed_at.toISOString(), observedAt);
  assert.deepEqual(stockRun.last_counts, { updated: 2, failed: 1 });
  assert.equal(calls.length, 8, 'Only the existing Hub request paths were used.');
  console.log('PASS: actual stock/sales/accepted-quote jobs preserve Hub observation time, zero vs unknown, and retained evidence on failure/partial update. Local fake Hub only.');
} finally {
  await new Promise(resolve => server.close(resolve));
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
