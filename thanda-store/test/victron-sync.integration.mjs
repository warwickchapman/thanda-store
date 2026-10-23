// Opt-in actual-job integration. A random schema in one disposable loopback
// database and a strict fetch preloader prevent production/provider access.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ensureProductSchema } from '../scripts/product-sync-lib.mjs';
import { ensureReviewSchema, exclusion } from '../src/lib/victron-catalogue-review.mjs';
import { ensureInventoryEvidenceSchema } from '../src/lib/inventory-scope.mjs';
import { startDataSync, finishDataSync } from '../src/lib/data-sync-state.mjs';
import { recordVictronMediaAttempt } from '../src/lib/victron-media.mjs';

if (process.env.RUN_VICTRON_SYNC_DB_TESTS !== '1') throw new Error('Set RUN_VICTRON_SYNC_DB_TESTS=1 with the disposable local database.');
const database = new URL(process.env.DATABASE_URL || '');
if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.hostname !== '127.0.0.1'
  || database.port !== '55438' || database.pathname !== '/victron_sync_test') {
  throw new Error('This test requires 127.0.0.1:55438/victron_sync_test; all other databases are refused.');
}
const schema = `victron_sync_test_${crypto.randomBytes(6).toString('hex')}`;
database.searchParams.delete('options');
const admin = new pg.Pool({ connectionString: database.toString() });
database.searchParams.set('options', `-c search_path=${schema}`);
const pool = new pg.Pool({ connectionString: database.toString() });
const cwd = fileURLToPath(new URL('../', import.meta.url));
const apiRoot = 'https://victron.test/api/v1';
const xs70 = 'ORI121221040';
const predecessor = 'PMP482305010';
const successor = 'PMP482305012';
const empty = 'ZZ-EMPTY';
const day = 86_400_000;
const calls = [];
let catalogueMode = 'complete';
let mediaMode = 'success';
let sourcePrice = 100;
let includeCold = false;
let invalidXsPrice = false;

function supplier(sku, description, stock = 4) {
  return { sku, description, category: 'DC-DC converters', price: invalidXsPrice && sku === xs70 ? null : sourcePrice,
    currency: 'ZAR', enduser_price_zar: { price: 200 }, all_stock_by_warehouse: { af_sa_inzuzo: stock } };
}
function catalogue() {
  return [supplier(xs70, 'Orion XS 12/12-70A DC-DC battery charger'),
    supplier(predecessor, `MultiPlus 48/3000 230V *If 0, order ${successor}*`, 0),
    supplier(successor, 'MultiPlus 48/3000 230V'),
    supplier('SPM040000000', 'Solar panel'), supplier('REG120', 'Charger 120V'),
    supplier('REGAPP120', 'Approved charger 120V'), supplier('MANUAL', 'Supplier name'),
    supplier(empty, 'Retained media product'), supplier('UNTRACKED-NEW', 'Unapproved global item'),
    ...(includeCold ? [supplier('COLD-NEW', 'New product while inventory is unavailable')] : [])];
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, apiRoot);
  calls.push({ path: url.pathname, offset: url.searchParams.get('offset') });
  response.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/api/v1/products/') {
    const offset = Number(url.searchParams.get('offset') || 0);
    if (catalogueMode === 'partial' && offset > 0) {
      response.end(JSON.stringify({ count: catalogue().length, results: [] })); return;
    }
    const rows = catalogue();
    const nextOffset = offset + 2;
    response.end(JSON.stringify({ count: rows.length, results: rows.slice(offset, nextOffset),
      next: nextOffset < rows.length ? `${apiRoot}/products/?format=json&limit=2&offset=${nextOffset}` : null }));
    return;
  }
  const sku = url.pathname.match(/^\/api\/v1\/products-extended\/([^/]+)\/$/)?.[1];
  if (sku) {
    if (mediaMode === 'rate-limited') {
      response.statusCode = 429; response.setHeader('Retry-After', '300');
      response.end('{"detail":"Synthetic media cooldown"}'); return;
    }
    response.end(JSON.stringify({ sku, product_data: sku === empty ? {} : {
      main_images: [{ url: `https://www.victronenergy.com/upload/${sku}.png` }],
      description: `Official ${sku} description`, documents: [],
    } })); return;
  }
  response.statusCode = 404; response.end('{}');
});

async function runJob({ extended = false, preferred = xs70, expectedCode = 0, reset = true } = {}) {
  if (reset) {
    // Tests control only their isolated local schedule/controller rows. The
    // production implementation and fetch pacing remain unmodified.
    await pool.query("UPDATE victron_catalogue_schedule SET last_attempt_at=now()-interval '1 day',next_scheduled_at=now()-interval '1 day'");
    await pool.query('UPDATE victron_http_state SET blocked_until=NULL,next_request_at=NULL');
  }
  const before = calls.length;
  const child = spawn(process.execPath, ['--import', './test/fixtures/victron-api-preload.mjs',
    './scripts/sync-victron-products.mjs', '--manual', '--media-sku', preferred], {
    cwd, env: { ...process.env, DATABASE_URL: database.toString(),
      VICTRON_TEST_API_URL: `http://127.0.0.1:${server.address().port}/`,
      VICTRON_EORDER_API_ROOT: apiRoot, VICTRON_EORDER_API_KEY: 'synthetic-victron-integration-key',
      VICTRON_ALLOWLIST_FILE: '/does-not-exist/quarterly-files-must-not-be-read.json',
      VICTRON_RATE_LIMIT_CACHE_FILE: '/does-not-exist/no-legacy-cooldown.json',
      VICTRON_SYNC_EXTENDED: extended ? '1' : '0', VICTRON_MEDIA_BATCH_SIZE: '2',
      VICTRON_PAGE_SIZE: '2', VICTRON_PAGE_REQUEST_DELAY_MS: '0', VICTRON_EXTENDED_REQUEST_DELAY_MS: '0',
      VICTRON_REQUEST_TIMEOUT_MS: '20000' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Fixture sync exceeded 45 seconds')); }, 45_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', result => { clearTimeout(timeout); resolve(result); });
  });
  assert.equal(code, expectedCode, `${stdout}\n${stderr}`);
  const requests = calls.slice(before);
  assert.ok(requests.every(call => /^\/api\/v1\/(?:products|products-extended)\//.test(call.path)), 'only fake E-Order requests occur');
  return { stats: expectedCode === 0 ? JSON.parse(stdout.trim()) : null, requests };
}
const product = async sku => (await pool.query('SELECT * FROM products WHERE sku=$1', [sku])).rows[0];
const evidence = async () => (await pool.query('SELECT observed_at,products FROM victron_catalogue_evidence WHERE id=true')).rows[0];
const runStatus = async () => (await pool.query("SELECT * FROM data_sync_status WHERE source_id='victron'")).rows[0];

try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await ensureProductSchema(pool);
  await ensureReviewSchema(pool);
  await ensureInventoryEvidenceSchema(pool);
  await startDataSync(pool, 'thanda');
  const now = new Date().toISOString();
  await finishDataSync(pool, 'thanda', { observedAt: now });
  const tracked = [xs70, successor, 'SPM040000000', 'REG120', 'REGAPP120'];
  await pool.query(`INSERT INTO thanda_inventory_evidence(company,observed_at,snapshot,items)
    VALUES('thanda-solar',$1,'complete-fixture',$2::jsonb)`, [now, JSON.stringify(tracked.map((Code, index) => ({
    Code, ItemID: `item-${index}`, Name: `Victron ${Code}`, IsTrackedAsInventory: true, QuantityOnHand: Code === xs70 ? 2 : 0,
  })))]);
  const protectedDetails = { storeManaged: true, hidden: true, localStockOnHand: 3,
    description: 'Manual description', documents: [{ title: 'Manual document', url: '/manual.pdf' }] };
  const retainedDetails = { description: 'Retained description', documents: [{ title: 'Retained document', url: 'https://www.victronenergy.com/old.pdf' }] };
  for (const [sku, image, details] of [[xs70, '', { localStockOnHand: 2 }],
    [predecessor, 'https://www.victronenergy.com/old.png', { localStockOnHand: 5 }],
    ['MANUAL', '/api/store-product-images/manual-test', protectedDetails],
    [empty, 'https://www.victronenergy.com/retained.png', retainedDetails]]) {
    await pool.query(`INSERT INTO products(sku,supplier,supplier_item_id,name,category,price,image_url,details)
      VALUES($1,'victron',$1,$2,'Original category',99,$3,$4::jsonb)`, [sku, sku === 'MANUAL' ? 'Manual name' : sku, image, JSON.stringify(details)]);
  }
  await pool.query(`INSERT INTO victron_catalogue_events(actor,action,company,sku,details)
    VALUES('fixture','review-approved','thanda-solar','REGAPP120',$1::jsonb)`,
  [JSON.stringify({ approvedReason: exclusion(supplier('REGAPP120', 'Approved charger 120V')) })]);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // Bootstrap only the local controller tables; the job owns normal schema use.
  const { ensureVictronHttpSchema } = await import('../src/lib/victron-http.mjs');
  await ensureVictronHttpSchema(pool);

  const first = await runJob();
  assert.equal(first.requests.filter(call => call.path === '/api/v1/products/').length, 5);
  assert.equal(first.requests.filter(call => call.path.includes('products-extended')).length, 2);
  assert.equal(first.requests.find(call => call.path.includes('products-extended')).path, `/api/v1/products-extended/${xs70}/`);
  assert.equal(first.stats.requests, 7);
  assert.equal(first.stats.discoveryDeferred, null);
  assert.deepEqual(first.stats.added.sort(), [successor, 'REGAPP120'].sort());
  assert.match((await product(xs70)).image_url, new RegExp(`${xs70}\\.png$`));
  assert.equal((await product(xs70)).details.localStockOnHand, 2);
  assert.ok((await product(xs70)).details.supplierObservedAt);
  assert.equal((await product(xs70)).details.supplierStockStatus, 'known');
  for (const sku of ['SPM040000000', 'REG120', 'UNTRACKED-NEW']) assert.equal(await product(sku), undefined, `${sku} must not be published`);
  assert.equal((await product('MANUAL')).name, 'Manual name');
  assert.equal((await product('MANUAL')).price, '99.00');
  assert.equal((await product('MANUAL')).details.hidden, true);
  assert.equal((await product('MANUAL')).image_url, '/api/store-product-images/manual-test');
  assert.equal((await product('MANUAL')).details.description, protectedDetails.description);
  assert.deepEqual((await pool.query('SELECT predecessor_sku,successor_sku FROM victron_sku_successions')).rows,
    [{ predecessor_sku: predecessor, successor_sku: successor }]);
  assert.equal((await product(predecessor)).details.localStockOnHand, 5, 'supplier succession does not move historical stock');
  assert.equal((await evidence()).products.length, 9, 'complete evidence includes excluded global products');

  // Explicit maintenance of a due item preserves every valid cached field when
  // the manufacturer returns a structurally valid but empty media response.
  await pool.query(`INSERT INTO victron_product_media_state(sku,attempted_at,next_attempt_at,last_outcome)
    SELECT sku,now(),now()+interval '100 days','success' FROM products WHERE supplier='victron'
    ON CONFLICT(sku) DO UPDATE SET next_attempt_at=EXCLUDED.next_attempt_at`);
  await pool.query(`INSERT INTO victron_product_media_state(sku,attempted_at,next_attempt_at,last_outcome)
    VALUES($1,now()-interval '1 day',now()-interval '1 second','missing')
    ON CONFLICT(sku) DO UPDATE SET next_attempt_at=EXCLUDED.next_attempt_at`, [empty]);
  const sparse = await runJob({ extended: true, preferred: empty });
  assert.equal(sparse.requests.filter(call => call.path.includes('products-extended')).length, 1);
  assert.equal((await product(empty)).image_url, 'https://www.victronenergy.com/retained.png');
  assert.equal((await product(empty)).details.description, retainedDetails.description);
  assert.deepEqual((await product(empty)).details.documents, retainedDetails.documents);
  assert.equal((await runStatus()).last_status, 'success');

  // Actual persisted SQL backoff grows and caps, and an older attempt cannot
  // overwrite a more recent retry decision.
  const base = Date.now() - 60_000;
  for (const [outcome, expectedDays] of [['failed', [1, 2, 4, 7]], ['missing', [7, 14, 28, 28]]]) {
    const sku = `BACKOFF-${outcome.toUpperCase()}`;
    let last;
    for (let index = 0; index < expectedDays.length; index++) {
      last = await recordVictronMediaAttempt(pool, sku, { outcome, now: base + index });
      assert.equal(last.next_attempt_at.getTime() - last.attempted_at.getTime(), expectedDays[index] * day);
      assert.equal(last.unsuccessful_attempts, index + 1);
    }
    assert.equal(await recordVictronMediaAttempt(pool, sku, { outcome, now: base - 1 }), null);
    assert.equal((await pool.query('SELECT attempted_at FROM victron_product_media_state WHERE sku=$1', [sku])).rows[0].attempted_at.getTime(), last.attempted_at.getTime());
  }

  // Photo cooldown happens after atomic basic publication, stops the media
  // batch and persists a deadline used by a subsequent invocation.
  await pool.query("UPDATE victron_product_media_state SET next_attempt_at=now()-interval '1 second'");
  mediaMode = 'rate-limited';
  const limited = await runJob({ extended: true, preferred: xs70 });
  assert.equal(limited.requests.filter(call => call.path.includes('products-extended')).length, 1);
  assert.equal(limited.stats.media.failed.length, 1);
  assert.equal((await runStatus()).last_status, 'success');
  assert.ok((await pool.query("SELECT blocked_until FROM victron_http_state WHERE scope='catalogue'")).rows[0].blocked_until > new Date());
  const paused = await runJob({ reset: false });
  assert.equal(paused.stats.reason, 'rate_limited');
  assert.equal(paused.requests.length, 0);
  mediaMode = 'success';

  // Cold inventory evidence defers discovery only, while an existing SKU keeps
  // receiving its live supplier observation and cost.
  await pool.query('DROP TABLE thanda_inventory_evidence');
  includeCold = true; sourcePrice = 110;
  const cold = await runJob();
  assert.match(cold.stats.discoveryDeferred, /saved Thanda inventory/);
  assert.equal(await product('COLD-NEW'), undefined);
  assert.equal((await product(xs70)).price, '110.00');
  assert.equal((await runStatus()).last_status, 'success');

  // Invalid current price evidence is a genuine source issue, but cannot erase
  // a saved cost/retail price or prevent reliable supplier stock publication.
  const priced = await product(xs70);
  invalidXsPrice = true;
  const invalidPrice = await runJob();
  assert.deepEqual(invalidPrice.stats.unverifiedPrices, [xs70]);
  assert.equal((await product(xs70)).price, priced.price);
  assert.equal((await product(xs70)).details.recommendedRetailExVat, priced.details.recommendedRetailExVat);
  assert.equal((await product(xs70)).details.supplierPriceStatus, 'unknown');
  assert.equal((await product(xs70)).details.supplierStockStatus, 'known');
  assert.equal((await runStatus()).last_status, 'partial');
  invalidXsPrice = false;

  const published = await evidence();
  catalogueMode = 'partial';
  const partial = await runJob({ expectedCode: 1 });
  assert.equal(partial.requests.length, 2);
  assert.deepEqual(await evidence(), published, 'incomplete pagination cannot replace complete supplier evidence');
  assert.equal((await runStatus()).last_status, 'failed');
  catalogueMode = 'complete'; sourcePrice = 125;
  await pool.query(`CREATE FUNCTION reject_product_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.sku='${empty}' THEN RAISE EXCEPTION 'Synthetic product write failure'; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER reject_product_update BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION reject_product_update()');
  await runJob({ expectedCode: 1 });
  assert.equal((await product(xs70)).price, '110.00', 'a late product failure rolls back earlier upserts');
  assert.deepEqual(await evidence(), published, 'failed publication retains the previous complete catalogue snapshot');
  assert.equal((await runStatus()).last_status, 'failed');
  console.log('PASS: actual Victron sync refreshes XS70 without quarterly files, gates discovery, preserves editorial/media data, bounds photo work, persists backoff/cooldowns and publishes complete evidence atomically. Local fake API only.');
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
