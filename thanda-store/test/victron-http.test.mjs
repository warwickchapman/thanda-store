import test from 'node:test';
import assert from 'node:assert/strict';
import { createVictronHttp, requestKind, retryDeadline, nextCatalogueRun, transportErrorKind, VictronPaused } from '../src/lib/victron-http.mjs';
import { resolvedTrackingUrl } from '../src/lib/victron-order-sync.mjs';

const root = 'https://eorder.victronenergy.com/api/v1';
function database() {
  const states = new Map();
  const usage = [];
  let locked = false;
  const db = { async query(sql, values = []) {
    if (sql.includes('pg_try_advisory_lock')) { const available = !locked; locked = true; return { rows: [{ locked: available }] }; }
    if (sql.includes('pg_advisory_unlock')) { locked = false; return { rows: [] }; }
    if (sql.startsWith('SELECT * FROM victron_http_state')) return { rows: [states.get(values[1]), states.get('account')].filter(Boolean) };
    if (sql.startsWith('INSERT INTO victron_http_usage')) { usage.push({ values, outcome: sql.includes("'skipped'") ? 'skipped' : 'started' }); return { rows: [{ id: usage.length }] }; }
    if (sql.startsWith('UPDATE victron_http_usage')) { Object.assign(usage[values[0] - 1], sql.includes('error_kind=') ? { outcome: values[1], errorKind: values[2] } : { status: values[1], outcome: values[2] }); return { rows: [] }; }
    if (sql.startsWith('INSERT INTO victron_http_state')) {
      if (sql.includes("'account'")) { states.set('account', { blocked_until: values[1] }); }
      else states.set(values[1], { blocked_until: values[2], last_status: values[3], quota: values[4] });
      return { rows: [] };
    }
    if (sql.startsWith('CREATE') || sql.startsWith('ALTER')) return { rows: [] };
    throw new Error(`Unexpected test query: ${sql}`);
  }, release() {} };
  return { states, usage, query: db.query, connect: async () => db };
}
test('Retry-After supports seconds, dates and a conservative fallback', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  assert.equal(retryDeadline('120', now).getTime(), now + 120000);
  assert.equal(retryDeadline('Thu, 01 Oct 2026 04:00:00 GMT', now).getTime(), now + 14400000);
  assert.equal(retryDeadline(null, now).getTime(), now + 3600000);
  assert.equal(retryDeadline('invalid', now).getTime(), now + 3600000);
});
test('catalogue due time aligns with timer despite start jitter', () => {
  assert.equal(nextCatalogueRun(Date.parse('2026-10-01T04:01:40Z')).toISOString(), '2026-10-01T08:00:00.000Z');
});
test('invoice products do not consume the catalogue cooldown scope', () => {
  assert.equal(requestKind(`${root}/orders/invoices/123/products/`).scope, 'orders');
  assert.equal(requestKind(`${root}/products/`).scope, 'catalogue');
  assert.equal(requestKind('https://eorder.victronenergy.com/tracktrace/a/b/123/').scope, 'tracking');
});
test('429 persists across client instances; other scopes can still proceed; no secrets in ledger', async () => {
  const pool = database();
  let calls = 0;
  const options = { pool, apiKey: 'secret-example', apiRoot: root, component: 'catalogue', fetchImpl: async () => {
    calls++; return new Response('throttled', { status: 429, headers: { 'Retry-After': '600' } });
  } };
  await assert.rejects(createVictronHttp(options).request(`${root}/products/`), VictronPaused);
  await assert.rejects(createVictronHttp(options).request(`${root}/products/`), VictronPaused);
  assert.equal(calls, 1);
  assert.equal(pool.usage[1].outcome, 'skipped');
  const orders = createVictronHttp({ ...options, component: 'orders', trigger: 'manual', fetchImpl: async () => new Response('[]') });
  assert.equal((await orders.request(`${root}/orders/shipments/`)).status, 200);
  assert.equal(JSON.stringify(pool.usage).includes('secret-example'), false);
  assert.equal(pool.usage[2].values[2], 'manual');
});
test('unexpected origins and per-run limits stop before transport', async () => {
  let calls = 0;
  const http = createVictronHttp({ pool: database(), apiKey: 'test', apiRoot: root, component: 'orders', maxRequests: 1, fetchImpl: async () => { calls++; return new Response('[]'); } });
  await assert.rejects(http.request('https://example.com/products/'), /origin/);
  await http.request(`${root}/orders/shipments/`);
  await assert.rejects(http.request(`${root}/orders/backorders/`), /safety limit/);
  assert.equal(calls, 1);
});
test('concurrent clients cannot overlap their transport', async () => {
  const pool = database();
  let active = 0;
  let peak = 0;
  const options = { pool, apiKey: 'test', apiRoot: root, component: 'orders', fetchImpl: async () => {
    peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 30)); active--; return new Response('[]');
  } };
  await Promise.all([createVictronHttp(options).request(`${root}/orders/shipments/`), createVictronHttp(options).request(`${root}/orders/backorders/`)]);
  assert.equal(peak, 1);
});
test('transport failures are attributed and request lock is released', async () => {
  const pool = database();
  await assert.rejects(createVictronHttp({ pool, apiKey: 'test', apiRoot: root, component: 'orders', fetchImpl: async () => { throw Object.assign(new Error('private URL'), { cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }) }); } }).request(`${root}/orders/shipments/`));
  assert.equal(pool.usage.length, 1);
  assert.equal(pool.usage[0].outcome, 'transport_error');
  assert.equal(pool.usage[0].errorKind, 'dns');
  assert.equal(JSON.stringify(pool.usage).includes('private URL'), false);
  assert.equal((await pool.query('SELECT pg_try_advisory_lock')).rows[0].locked, true);
});
test('transport categories remain bounded and distinguish redirects, timeouts and body failures', () => {
  assert.equal(transportErrorKind(new Error('fetch failed', { cause: new Error('unexpected redirect') })), 'redirect_refused');
  assert.equal(transportErrorKind(new Error('fetch failed'), { aborted: true }), 'timeout');
  assert.equal(transportErrorKind(new Error('private response data'), null, 'response_body'), 'response_body');
  assert.equal(transportErrorKind(new Error('unknown private URL')), 'request_failed');
});
test('persisted account-wide cooldown blocks every API scope without requests', async () => {
  const pool = database();
  pool.states.set('account', { blocked_until: new Date(Date.now() + 60000) });
  let calls = 0;
  const http = createVictronHttp({ pool, apiKey: 'test', apiRoot: root, component: 'orders', fetchImpl: async () => { calls++; return new Response('[]'); } });
  await assert.rejects(http.request(`${root}/orders/shipments/`), VictronPaused);
  assert.equal(calls, 0);
});
test('persisted pacing delays the next transport start', async () => {
  const pool = database();
  const due = Date.now() + 100;
  pool.states.set('account', { next_request_at: new Date(due) });
  let started;
  const http = createVictronHttp({ pool, apiKey: 'test', apiRoot: root, component: 'orders', fetchImpl: async () => { started = Date.now(); return new Response('[]'); } });
  await http.request(`${root}/orders/shipments/`);
  assert.ok(started >= due);
});
test('resolved tracking is reused and a changed source URL is resolved afresh', async () => {
  const cache = new Map();
  let calls = 0;
  const options = { pool: { query: async (sql, values) => {
    if (sql.startsWith('SELECT')) return { rows: cache.has(values[0]) ? [cache.get(values[0])] : [] };
    cache.set(values[0], { resolved_url: values[1], resolved: values[2], checked_at: new Date() });
    return { rows: [] };
  } }, timeoutMs: 1000, fetchImpl: async () => { calls++; return new Response('https://epx.pperfect.com VIC26069837'); } };
  const invoice = { trackingUrl: 'https://eorder.victronenergy.com/tracktrace/a/1/' };
  assert.equal(await resolvedTrackingUrl(invoice, options), 'https://epx.pperfect.com/?w=VIC26069837');
  await resolvedTrackingUrl(invoice, options);
  assert.equal(calls, 1);
  await resolvedTrackingUrl({ trackingUrl: 'https://eorder.victronenergy.com/tracktrace/a/2/' }, options);
  assert.equal(calls, 2);
});
