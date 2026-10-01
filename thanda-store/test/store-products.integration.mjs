// Disposable PostgreSQL schema and local fake Hub. Never writes to Xero.
import pg from 'pg';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { ensureProductSchema } from '../scripts/product-sync-lib.mjs';
import { saveStoreProduct } from '../src/lib/admin/store-products.mjs';

if (process.env.RUN_STORE_PRODUCTS_DB_TESTS !== '1' || !process.env.DATABASE_URL) throw new Error('Set RUN_STORE_PRODUCTS_DB_TESTS=1 and a local test DATABASE_URL.');
const url = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use a local disposable database.');
const schema = `store_products_test_${crypto.randomBytes(6).toString('hex')}`;
const admin = new pg.Pool({ connectionString: url.toString() });
url.searchParams.set('options', `-c search_path=${schema}`);
const pool = new pg.Pool({ connectionString: url.toString() });
const observedAt = '2026-10-01T08:00:00.000Z';
let item = { ItemID: 'item-1', Code: 'NEW-ITEM', Name: 'Original Xero name', IsSold: true, IsTrackedAsInventory: true, QuantityOnHand: 3, SalesDetails: { UnitPrice: 100 } };
const calls = [];
const server = http.createServer((request, response) => {
  calls.push(request.url);
  response.setHeader('Content-Type', 'application/json');
  if (request.url.endsWith('/status')) response.end(JSON.stringify({ tenant_id: 'synthetic' }));
  else if (request.url.endsWith('/Items')) response.end(JSON.stringify({ Items: [item], _hub: { complete: true, snapshot: 'test', observed_at: observedAt } }));
  else { response.statusCode = 404; response.end('{}'); }
});
async function sync() {
  const child = spawn(process.execPath, ['scripts/sync-xero-stock.mjs'], {
    env: { ...process.env, DATABASE_URL: url.toString(), XERO_HUB_URL: `http://127.0.0.1:${server.address().port}`, XERO_HUB_TOKEN: 'test-only' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }), 0, output);
}
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await ensureProductSchema(pool);
  const input = { name: 'Store name', description: 'Store description', category: 'Other products', price: '149.95', visible: true };
  const args = { id: null, item, observedAt, input, image: Buffer.from('synthetic-photo'), imageRevision: 'test-photo', actorId: 123 };
  const results = await Promise.allSettled([saveStoreProduct(pool, args), saveStoreProduct(pool, args)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  const id = results.find(result => result.status === 'fulfilled').value;
  let row = (await pool.query('SELECT * FROM products WHERE id=$1', [id])).rows[0];
  assert.equal(row.details.localStockOnHand, 3);
  assert.equal(row.details.xeroStockSyncedAt, observedAt);
  assert.equal(row.details.storeEditedBy, 123);
  await saveStoreProduct(pool, { ...args, id, image: undefined, input: { ...input, price: '175.50', name: 'Edited store name', visible: false } });
  row = (await pool.query('SELECT * FROM products WHERE id=$1', [id])).rows[0];
  assert.equal(row.details.hidden, true);
  assert.equal(row.details.recommendedRetailExVat, 175.5);
  assert.equal((await pool.query('SELECT image FROM store_product_images WHERE product_id=$1', [id])).rows[0].image.toString(), 'synthetic-photo');
  await assert.rejects(() => saveStoreProduct(pool, { ...args, id: id + 1 }), /not editable/);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM products')).rows[0].count, 1);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  item = { ...item, Name: 'Changed Xero name', QuantityOnHand: 8, SalesDetails: { UnitPrice: 999 } };
  await sync();
  row = (await pool.query('SELECT * FROM products WHERE id=$1', [id])).rows[0];
  assert.equal(row.name, 'Edited store name'); assert.equal(row.price, '175.50');
  assert.equal(row.details.description, input.description); assert.equal(row.details.recommendedRetailExVat, 175.5);
  assert.equal(row.details.localStockOnHand, 8); assert.equal(row.details.hidden, true);
  assert.equal(row.image_url, `/api/store-product-images/${id}?v=test-photo`);
  item = { ...item, ItemID: 'different-item-reusing-code' };
  await sync();
  row = (await pool.query('SELECT * FROM products WHERE id=$1', [id])).rows[0];
  assert.equal(row.details.localStockOnHand, null); assert.equal(row.details.xeroStockStatus, 'missing');
  assert.equal(row.name, 'Edited store name'); assert.equal(row.details.recommendedRetailExVat, 175.5);
  assert.equal(calls.length, 4, 'Only the existing stock job Hub reads are used.');
  console.log('PASS: concurrent duplicate protection, transactional photos, edits/hiding, stock refresh without editorial/price loss, identity mismatch safety.');
} finally {
  await new Promise(resolve => server.close(resolve));
  await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
}
