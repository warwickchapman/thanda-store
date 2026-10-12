import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { validCustomerViewOrigin } from '../src/lib/auth/impersonation-origin.mjs';
import { catalogueReviewUrl } from '../src/lib/stock-review-view.mjs';
import { checkedXeroItem } from '../src/lib/stock-review.mjs';
import { assertHubSnapshot } from '../src/lib/xero/hub.mjs';

// Execute the actual Next handlers and real origin/snapshot checks. I/O is
// replaced so stale Victron clients cannot quietly reach either database or Hub.
const compiled = Object.fromEntries(['create-xero-item', 'stock-review'].map(name => {
  const source = fs.readFileSync(new URL(`../src/app/api/admin/data-health/${name}/route.ts`, import.meta.url), 'utf8');
  return [name, ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText];
}));
const observedAt = new Date().toISOString();
const lora = { supplier: 'lora', sku: 'LORA-SENSOR', details: { xeroStockStatus: 'missing' } };

function harness(route, options = {}) {
  const sql = [], hubCalls = [];
  let connects = 0, releases = 0;
  const query = async (text, args) => {
    sql.push({ text, args });
    assert.ok(options.allowIo, 'A retired or rejected request must not query the database');
    if (text.startsWith('SELECT supplier, sku, details FROM products')) return { rows: options.products || [lora] };
    if (text.startsWith('SELECT pg_try_advisory_lock')) return { rows: [{ locked: options.locked !== false }] };
    if (text.startsWith('SELECT MAX(last_checked_at)')) return { rows: [{ checked_at: options.recentCheck || null }] };
    if (text.startsWith('SELECT details FROM products')) return { rows: [{ details: { xeroStockStatus: options.currentStatus || 'missing' } }] };
    if (text.startsWith('UPDATE products')) return { rows: [{ sku: lora.sku }], rowCount: options.newerObservation ? 0 : 1 };
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text) || text.startsWith('INSERT INTO product_stock_review') || text.startsWith('SELECT pg_advisory_unlock')) return { rows: [] };
    throw new Error(`Unexpected SQL: ${text}`);
  };
  const modules = {
    'next/server': { NextResponse: Response },
    '@/lib/db': { query, connect: async () => {
      connects++;
      assert.ok(options.allowIo, 'A retired or rejected request must not acquire a database client');
      return { query, release: () => { releases++; } };
    } },
    '@/lib/auth/server': { currentUser: async () => options.user === undefined ? { id: 7, role: 'admin' } : options.user },
    '@/lib/auth/impersonation-origin.mjs': { validCustomerViewOrigin },
    '@/lib/stock-review-view.mjs': { catalogueReviewUrl },
    '@/lib/stock-review.mjs': { checkedXeroItem },
    '@/lib/xero/hub.mjs': { assertHubSnapshot, hubFetch: async path => {
      hubCalls.push(path);
      assert.ok(options.allowIo, 'A retired or rejected request must not contact the Hub');
      return options.hubResponse || Response.json({ Items: [{ Code: lora.sku, IsTrackedAsInventory: true, QuantityOnHand: 0 }],
        _hub: { complete: true, snapshot: 'stored-revision', observed_at: observedAt } });
    } },
  };
  const exports = {};
  vm.runInNewContext(compiled[route], { exports, require: name => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected import ${name}`);
    return modules[name];
  }, process: { env: { NODE_ENV: 'production' } }, Request, Response, Date, Set, JSON, Error, URL,
  console: { error: () => {} } });
  return { sql, hubCalls, connects: () => connects, releases: () => releases,
    post: async body => {
      const headers = { 'Content-Type': 'application/json' };
      if (options.origin !== null) headers.Origin = options.origin || 'https://store.thanda.solar';
      const response = await exports.POST(new Request(`https://store.thanda.solar/api/admin/data-health/${route}`, {
        method: 'POST', headers, body: options.rawBody ?? JSON.stringify(body),
      }));
      return { status: response.status, headers: response.headers, body: await response.json() };
    },
  };
}

function assertNoIo(h) {
  assert.equal(h.connects(), 0);
  assert.equal(h.sql.length, 0);
  assert.equal(h.hubCalls.length, 0);
}

test('both Data health endpoints require an actual admin and same-origin request before I/O', async () => {
  for (const route of Object.keys(compiled)) {
    for (const user of [null, { id: 7, role: 'customer' }, { id: 7, role: 'admin', impersonatedBy: 1 }]) {
      const h = harness(route, { user });
      const result = await h.post({ supplier: 'victron', sku: 'PMP482305010', action: 'create' });
      assert.equal(result.status, 403);
      assert.equal(result.body.error, 'Admin access required');
      assertNoIo(h);
    }
    for (const origin of [null, 'https://untrusted.example', 'https://store.thanda.solar/path']) {
      const h = harness(route, { origin });
      const result = await h.post({ supplier: 'victron', sku: 'PMP482305010', action: 'create' });
      assert.equal(result.status, 403);
      assert.equal(result.body.error, 'Same-origin request required');
      assertNoIo(h);
    }
  }
});

test('old Victron previews and creations redirect to current catalogue review with no reads or writes', async () => {
  // Each literal predecessor/successor and retail code keeps its own lookup URL;
  // rejecting an old request must not create another succession mapping.
  for (const sku of ['PMP482305010', 'PMP482305012', 'BPC121532024R']) {
    for (const action of ['preview', 'create']) {
      const h = harness('create-xero-item');
      const result = await h.post({ action, sku, fingerprint: 'formerly-valid', supplier: 'victron' });
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'USE_CATALOGUE_REVIEW');
      assert.match(result.body.error, /Victron catalogue review/);
      assert.equal(result.body.reviewUrl, catalogueReviewUrl(sku));
      assertNoIo(h);
    }
  }
});

test('every stale Victron stock-check or decision is rejected before client acquisition', async () => {
  for (const action of ['check', 'do_not_stock', 'undo', 'retired', 'restore_purchasing', 'archive_purchasing', 'unknown']) {
    const h = harness('stock-review');
    // A legacy retirement request without a note also reaches the new workflow,
    // rather than being allowed to retain an independent Data health decision.
    const result = await h.post({ supplier: 'victron', sku: ' pmp482305010 ', action });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'USE_CATALOGUE_REVIEW');
    assert.equal(result.body.reviewUrl, catalogueReviewUrl('PMP482305010'));
    assertNoIo(h);
  }
});

test('malformed requests and unsupported LoRa actions fail locally', async () => {
  for (const body of [null, {}, { action: 'create', sku: '' }, { action: 'create', sku: 'lowercase' }, { action: 'unknown', sku: 'PMP482305010' }]) {
    const h = harness('create-xero-item');
    assert.equal((await h.post(body)).status, 400);
    assertNoIo(h);
  }
  for (const body of [null, {}, { supplier: 'renogy', sku: 'A', action: 'check' }, { supplier: 'lora', sku: 'A', action: 'retired', note: 'evidence' },
    { supplier: 'lora', sku: 'A', action: 'restore_purchasing' }, { supplier: 'lora', sku: 'A', action: 'archive_purchasing' },
    { supplier: 'lora', sku: 'A', action: 'do_not_stock', note: 'x'.repeat(1001) }]) {
    const h = harness('stock-review');
    assert.equal((await h.post(body)).status, 400);
    assertNoIo(h);
  }
  for (const route of Object.keys(compiled)) {
    const h = harness(route, { rawBody: 'invalid JSON' });
    assert.equal((await h.post({})).status, 400);
    assertNoIo(h);
  }
});

test('LoRa checks retain complete stored Hub observations and confirmed tracked zero', async () => {
  const h = harness('stock-review', { allowIo: true });
  const result = await h.post({ ...lora, sku: ' lora-sensor ', action: 'check' });
  assert.equal(result.status, 200);
  assert.equal(result.body.resolved, true);
  assert.equal(result.body.observedAt, observedAt);
  assert.deepEqual(h.hubCalls, ['/Items']);
  const update = h.sql.find(call => call.text.startsWith('UPDATE products'));
  assert.deepEqual(Array.from(update.args), ['lora', lora.sku, 0, 'tracked', observedAt]);
  assert.ok(h.sql.some(call => call.text.includes("VALUES ($1,$2,'check',$3,$4)")));
  assert.ok(h.sql.some(call => call.text === 'COMMIT'));
  assert.ok(h.sql.some(call => call.text.startsWith('SELECT pg_advisory_unlock')));
  assert.equal(h.releases(), 1);
});

test('LoRa do-not-stock and undo remain local audited decisions without stock writes', async () => {
  for (const action of ['do_not_stock', 'undo']) {
    const h = harness('stock-review', { allowIo: true });
    const result = await h.post({ ...lora, action, note: ' staff reason ' });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(h.hubCalls.length, 0);
    assert.ok(!h.sql.some(call => call.text.startsWith('UPDATE products')));
    const decision = h.sql.find(call => call.text.startsWith('INSERT INTO product_stock_reviews'));
    assert.deepEqual(Array.from(decision.args), ['lora', lora.sku, action === 'undo' ? null : action, 'staff reason', 7]);
    const audit = h.sql.find(call => call.text.startsWith('INSERT INTO product_stock_review_events'));
    assert.deepEqual(Array.from(audit.args), ['lora', lora.sku, action, 'staff reason', 7]);
    assert.ok(h.sql.some(call => call.text === 'COMMIT'));
    assert.equal(h.releases(), 1);
  }
});

test('LoRa checks preserve locks, cooldown and newer observations; no success is invented', async () => {
  for (const options of [{ locked: false }, { recentCheck: new Date().toISOString() }]) {
    const h = harness('stock-review', { allowIo: true, ...options });
    const result = await h.post({ ...lora, action: 'check' });
    assert.equal(result.status, options.locked === false ? 409 : 429);
    if (options.recentCheck) assert.equal(result.headers.get('Retry-After'), '60');
    assert.equal(h.hubCalls.length, 0);
    assert.ok(!h.sql.some(call => call.text.startsWith('UPDATE products')));
    assert.equal(h.releases(), 1);
  }
  const newer = harness('stock-review', { allowIo: true, newerObservation: true });
  assert.equal((await newer.post({ ...lora, action: 'check' })).status, 409);
  assert.ok(newer.sql.some(call => call.text === 'ROLLBACK'));
  assert.ok(!newer.sql.some(call => call.text.startsWith('INSERT INTO product_stock_review_events')));
  assert.equal(newer.releases(), 1);
  const resolved = harness('stock-review', { allowIo: true, currentStatus: 'tracked' });
  assert.equal((await resolved.post({ ...lora, action: 'do_not_stock' })).status, 409);
  assert.ok(resolved.sql.some(call => call.text === 'ROLLBACK'));
  assert.ok(!resolved.sql.some(call => call.text.startsWith('INSERT INTO product_stock_reviews')));
  assert.equal(resolved.hubCalls.length, 0);
  assert.equal(resolved.releases(), 1);
});
