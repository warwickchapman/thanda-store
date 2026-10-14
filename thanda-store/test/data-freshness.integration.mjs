// Opt-in, disposable schema and local fake Hub only. No supplier/Xero calls.
import pg from 'pg';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { ensureProductSchema } from '../scripts/product-sync-lib.mjs';
import { startDataSync, finishDataSync } from '../src/lib/data-sync-state.mjs';
import { localStockObservation } from '../src/lib/data-freshness.mjs';
import { loadInventoryScope } from '../src/lib/inventory-scope.mjs';

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
let itemsMode = 'initial';
let inventoryObservedAt = observedAt;
let inventoryLastError = null;
const calls = [];
const server = http.createServer((request, response) => {
  calls.push(request.url);
  response.setHeader('Content-Type', 'application/json');
  if (failHub) { response.statusCode = 503; response.end('{"error":"Synthetic outage"}'); return; }
  if (request.url.endsWith('/status')) {
    response.end(JSON.stringify({ tenant_id: 'synthetic-tenant', scope: 'accounting.invoices' })); return;
  }
  const meta = { complete: true, company: 'thanda-solar', snapshot: `synthetic-${itemsMode}`, observed_at: observedAt };
  if (request.url.includes('/Items')) {
    response.end(JSON.stringify({ _hub: { ...meta, observed_at: inventoryObservedAt, last_error: inventoryLastError }, Items: [
      ...(itemsMode === 'removed' ? [] : [{ ItemID: 'zero-item', Code: 'KNOWN-ZERO', IsTrackedAsInventory: true, QuantityOnHand: itemsMode === 'changed' ? 8 : 0 }]),
      { ItemID: 'untracked-item', Code: 'UNTRACKED', IsTrackedAsInventory: false },
      { ItemID: 'invalid-item', Code: 'INVALID-QTY', IsTrackedAsInventory: true, QuantityOnHand: [] },
      { ItemID: 'lora-item', Code: 'LORA-RS-00120', IsTrackedAsInventory: true, QuantityOnHand: 4 },
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
  const before = calls.length;
  const child = spawn(process.execPath, [`scripts/${script}`], {
    env: { ...process.env, DATABASE_URL: scopedUrl.toString(), XERO_HUB_URL: `http://127.0.0.1:${server.address().port}`, XERO_HUB_TOKEN: 'synthetic-test-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, expectedCode, output);
  assert.equal(calls.length - before, failHub ? 1 : script === 'sync-xero-sales-history.mjs' ? 3 : 2,
    'Only existing local fake Hub reads are used, including failed imports.');
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
  const initialEvidence = (await pool.query('SELECT * FROM thanda_inventory_evidence')).rows[0];
  assert.equal(initialEvidence.company, 'thanda-solar');
  assert.equal(initialEvidence.items.length, 4);
  assert.equal(initialEvidence.previously_tracked['KNOWN-ZERO'], observedAt);
  assert.ok(!Object.hasOwn(initialEvidence.items[0], 'SalesDetails'), 'snapshot retains inventory fields only');

  // A product update failure rolls back the complete inventory publication,
  // earlier product updates and the successful-run metadata together.
  await pool.query(`CREATE FUNCTION fail_inventory_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.sku='UNTRACKED' THEN RAISE EXCEPTION 'Synthetic product failure'; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER fail_inventory_update BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION fail_inventory_update()');
  itemsMode = 'changed';
  inventoryObservedAt = '2026-09-20T08:30:00.000Z';
  await runScript('sync-xero-stock.mjs', 1);
  assert.equal((await pool.query('SELECT snapshot FROM thanda_inventory_evidence')).rows[0].snapshot, initialEvidence.snapshot);
  assert.equal((await pool.query("SELECT details->'localStockOnHand' AS quantity FROM products WHERE sku='KNOWN-ZERO'")).rows[0].quantity, 0);
  assert.equal((await pool.query("SELECT last_status FROM data_sync_status WHERE source_id='thanda'")).rows[0].last_status, 'failed');
  await pool.query('DROP TRIGGER fail_inventory_update ON products');
  await runScript('sync-xero-stock.mjs');
  assert.equal((await pool.query("SELECT details->'localStockOnHand' AS quantity FROM products WHERE sku='KNOWN-ZERO'")).rows[0].quantity, 8);

  // A later complete absence clears current quantity but preserves the fact
  // that this was tracked inventory. It must not become catalogue-only.
  itemsMode = 'removed';
  inventoryObservedAt = '2026-09-20T09:00:00.000Z';
  await runScript('sync-xero-stock.mjs');
  const retainedEvidence = (await pool.query('SELECT * FROM thanda_inventory_evidence')).rows[0];
  assert.equal(retainedEvidence.previously_tracked['KNOWN-ZERO'], '2026-09-20T08:30:00.000Z');
  assert.ok(!retainedEvidence.items.some(item => item.Code === 'KNOWN-ZERO'));
  assert.equal((await pool.query("SELECT details->'localStockOnHand' AS quantity FROM products WHERE sku='KNOWN-ZERO'")).rows[0].quantity, null);
  inventoryObservedAt = observedAt;
  itemsMode = 'initial';
  await runScript('sync-xero-stock.mjs', 1);
  assert.equal((await pool.query('SELECT snapshot FROM thanda_inventory_evidence')).rows[0].snapshot, retainedEvidence.snapshot, 'older import does not replace current inventory or quantities');
  inventoryLastError = 'Synthetic incomplete upstream refresh';
  inventoryObservedAt = '2026-09-20T10:00:00.000Z';
  await runScript('sync-xero-stock.mjs', 1);
  assert.equal((await pool.query('SELECT snapshot FROM thanda_inventory_evidence')).rows[0].snapshot, retainedEvidence.snapshot, 'a Hub failure cannot be published as a successful stock observation');
  inventoryLastError = null;

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

  // Exercise the real set-oriented scope query, including JSON audit payloads,
  // against isolated local tables rather than merely stubbing SQL responses.
  await pool.query(`
    CREATE TABLE supplier_inbound_orders (id bigint PRIMARY KEY,supplier text,status text);
    CREATE TABLE supplier_inbound_order_lines (inbound_order_id bigint,sku text,is_stock_item boolean,ordered_quantity numeric,received_quantity numeric);
    CREATE TABLE victron_provisional_backorder_order_lines (sku text,quantity numeric);
    CREATE TABLE victron_provisional_cart_lines (sku text,quantity numeric);
    CREATE TABLE victron_stock_minima (sku text,minimum_stock numeric);
    CREATE TABLE victron_catalogue_events (company text,sku text,action text,created_at timestamptz,details jsonb);
    INSERT INTO victron_catalogue_events VALUES ('thanda-solar','NEW-CODE','applied','2026-09-20 09:00:00Z',
      '{"request":{"payload":{"action":"new","code":"NEW-CODE"}}}');
    INSERT INTO victron_provisional_backorder_order_lines VALUES ('OPEN-ORDER001',3);
  `);
  const contextRuns = ['thanda','sales','victron-orders','accepted-quotes'].map(source_id => ({
    source_id,last_status:'success',source_observed_at:'2026-09-20T09:00:00Z',last_successful_at:'2026-09-20T09:00:00Z',
  }));
  const assessed = await loadInventoryScope(pool, { products: (await pool.query('SELECT sku,supplier,name,details FROM products')).rows,
    runs: contextRuns, now: Date.parse('2026-09-20T09:01:00Z') });
  assert.equal(assessed.complete, true);
  assert.equal(assessed.articles.get('MISSING').kind, 'catalogue');
  assert.equal(assessed.articles.get('KNOWN-ZERO').kind, 'required', 'a tracked article cannot vanish into catalogue-only');
  assert.equal(assessed.articles.get('NEW-CODE').kind, 'required', 'new-item audit payload is recognized');
  assert.equal(assessed.articles.get('OPEN-ORDER001').kind, 'required', 'an order can require an article outside the storefront');

  failHub = true;
  await runScript('sync-xero-stock.mjs', 1);
  stockRun = (await pool.query("SELECT * FROM data_sync_status WHERE source_id='thanda'")).rows[0];
  assert.equal(stockRun.last_status, 'failed');
  assert.equal(stockRun.source_observed_at.toISOString(), '2026-09-20T09:00:00.000Z');
  assert.ok(stockRun.last_successful_at);
  await startDataSync(pool, 'thanda');
  assert.equal((await pool.query("SELECT last_status FROM data_sync_status WHERE source_id='thanda'")).rows[0].last_status, 'failed');
  await finishDataSync(pool, 'thanda', { status: 'partial', counts: { updated: 2, failed: 1 } });
  stockRun = (await pool.query("SELECT * FROM data_sync_status WHERE source_id='thanda'")).rows[0];
  assert.equal(stockRun.last_status, 'partial');
  assert.equal(stockRun.source_observed_at.toISOString(), '2026-09-20T09:00:00.000Z');
  assert.deepEqual(stockRun.last_counts, { updated: 2, failed: 1 });
  console.log('PASS: actual stock/sales/accepted-quote jobs preserve source time, zero vs unknown, atomic inventory publication, prior tracking and retained evidence on failure. Local fake Hub only.');
} finally {
  await new Promise(resolve => server.close(resolve));
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
