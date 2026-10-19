// Local disposable schema, fake Renogy and fake Resend only.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { recordRenogyAuthFailure, resolveRenogyAuthFailure, supplierAuthAlerts } from '../src/lib/supplier-auth-alerts.mjs';
import { runSupplierAuthNotifications } from '../src/lib/supplier-auth-notifications.mjs';

if (process.env.RUN_SUPPLIER_AUTH_DB_TESTS !== '1' || !process.env.DATABASE_URL) throw new Error('Set RUN_SUPPLIER_AUTH_DB_TESTS=1 with a local disposable DATABASE_URL.');
const url = new URL(process.env.DATABASE_URL);
if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Use a local disposable database.');
const schema = `supplier_auth_test_${crypto.randomBytes(5).toString('hex')}`;
const root = new pg.Pool({ connectionString: url.toString() });
url.searchParams.set('options', `-c search_path=${schema}`);
const pool = new pg.Pool({ connectionString: url.toString() });
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'renogy-auth-test-'));
const tokenFile = path.join(directory, 'token.json');
const password = ' SYNTHETIC_SECRET with spaces ';
let mode = 'success';
const requests = [];
const server = http.createServer(async (request, response) => {
  requests.push(request.url);
  response.setHeader('Content-Type', 'application/json');
  if (mode === 'rate_limit') { response.statusCode = 429; response.setHeader('Retry-After','600'); response.end('{}'); return; }
  if (mode === 'outage') { response.statusCode = 503; response.end('{}'); return; }
  if (request.url.endsWith('/user/prelogin')) {
    let body = ''; for await (const chunk of request) body += chunk;
    assert.equal(JSON.parse(body).password, password, 'Passwords must retain meaningful spaces.');
    if (mode === 'login_server_error') { response.statusCode = 500; response.end(JSON.stringify({ msg: password })); return; }
    response.end(JSON.stringify(mode === 'invalid_login' ? { code: 401, msg: password } : { code: 200, data: { token: 'fresh-test-token' } })); return;
  }
  if (request.url.endsWith('/user/info')) {
    const valid = !['invalid_login','login_server_error'].includes(mode) && request.headers.authorization === 'fresh-test-token';
    response.end(JSON.stringify(valid ? { code: 200, data: { id: 'test-contact' } } : { code: 401 })); return;
  }
  response.statusCode = 404; response.end('{}');
});
async function run({ credentials = false, authOnly = true } = {}) {
  const env = { ...process.env, DATABASE_URL: url.toString(), RENOGY_BASE_URL: `http://127.0.0.1:${server.address().port}/api/sc/portal`,
    RENOGY_TOKEN_CACHE_FILE: tokenFile, RENOGY_BEARER_TOKEN: 'expired-test-token', RENOGY_EMAIL: credentials ? 'test@example.test' : '', RENOGY_PASSWORD: credentials ? password : '' };
  const child = spawn(process.execPath, ['scripts/sync-renogy-products.mjs', ...(authOnly ? ['--check-auth'] : [])], { env, stdio: ['ignore','pipe','pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.ok(!output.includes(password) && !output.includes('fresh-test-token') && !output.includes('expired-test-token'), 'Credentials must not appear in logs.');
  return { code, output };
}
async function incident() { return (await pool.query("SELECT * FROM supplier_auth_incidents WHERE source_id='renogy'")).rows[0]; }
async function due() { await pool.query("UPDATE supplier_auth_emails SET next_attempt_at=NOW() WHERE state IN ('pending','accepted')"); }
const emails = [];
const delivered = async (endpoint, init) => {
  assert.ok(endpoint.startsWith('https://api.resend.com/emails'));
  if (init.method === 'POST') { emails.push({ key: init.headers['Idempotency-Key'], payload: JSON.parse(init.body) }); return Response.json({ id: crypto.randomUUID() }); }
  return Response.json({ last_event: 'delivered' });
};
const worker = (fetcher = delivered) => runSupplierAuthNotifications(pool, { fetcher, pause: async () => {} });
try {
  await root.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`CREATE TABLE portal_users(id BIGINT PRIMARY KEY,email TEXT,role TEXT,is_active BOOLEAN DEFAULT true,archived_at TIMESTAMPTZ);
    INSERT INTO portal_users(id,email,role,is_active) VALUES (1,'admin1@example.test','admin',true),(2,'admin2@example.test','admin',true),
    (3,'inactive@example.test','admin',false),(4,'buyer@example.test','buyer',true);`);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const failed = await run({ authOnly: false });
  assert.equal(failed.code, 1, failed.output);
  assert.match(failed.output, /Renogy authentication failed/);
  const first = await incident();
  await Promise.all([recordRenogyAuthFailure(pool), recordRenogyAuthFailure(pool)]);
  assert.equal((await incident()).incident_id, first.incident_id);
  const sync = (await pool.query("SELECT last_error FROM data_sync_status WHERE source_id='renogy'")).rows[0];
  assert.match(sync.last_error, /authentication failed/);
  assert.equal((await pool.query("SELECT to_regclass('products') AS name")).rows[0].name, null, 'Failed authentication must not create or rewrite catalogue stock.');
  process.env.RESEND_API_KEY = 'synthetic-email-key';
  assert.equal((await worker()).calls, 2);
  assert.deepEqual(emails.map(e => e.payload.to).sort(), ['admin1@example.test','admin2@example.test']);
  assert.equal((await worker()).calls, 0, 'Repeated worker runs do not repeat emails.');
  await due(); assert.equal((await worker()).calls, 2);
  assert.equal((await supplierAuthAlerts(pool))[0].email_accepted, 2);
  assert.equal((await worker()).calls, 0);
  const before = requests.length;
  const recovered = await run({ credentials: true });
  assert.equal(recovered.code, 0, recovered.output);
  assert.equal(requests.length - before, 3, 'Expired token uses one renewal and one retried identity request.');
  assert.ok((await incident()).resolved_at);
  assert.equal((await supplierAuthAlerts(pool)).length, 0);
  assert.equal((await fs.stat(tokenFile)).mode & 0o777, 0o600);
  const renewed = requests.length;
  assert.equal((await run()).code, 0);
  assert.equal(requests.length - renewed, 1, 'Fresh cached token wins over the expired environment token.');
  mode = 'outage'; assert.equal((await run({ credentials: true })).code, 1);
  assert.equal((await supplierAuthAlerts(pool)).length, 0, 'An HTTP outage is not reported as an auth rejection.');
  mode = 'rate_limit';
  assert.equal((await run({ credentials: true })).code, 1);
  const rateRequests = requests.length;
  assert.equal((await run({ credentials: true })).code, 75);
  assert.equal(requests.length, rateRequests, 'Renogy Retry-After survives job restarts and skips locally.');
  assert.equal((await supplierAuthAlerts(pool)).length, 0);
  await pool.query('UPDATE renogy_retry_state SET next_allowed_at=NULL');
  mode = 'invalid_login';
  const loginStart = requests.length;
  assert.equal((await run({ credentials: true })).code, 1);
  assert.equal(requests.slice(loginStart).filter(p => p.endsWith('/user/prelogin')).length, 1);
  assert.notEqual((await incident()).incident_id, first.incident_id);
  assert.equal((await supplierAuthAlerts(pool)).length, 1);
  mode = 'login_server_error';
  assert.equal((await run({ credentials: true })).code, 1, 'Login server errors must not echo submitted credentials.');
  const limited = await worker(async () => Response.json({ name: 'rate_limit_exceeded' }, { status: 429, headers: { 'Retry-After': '120' } }));
  assert.equal(limited.calls, 1);
  assert.ok(new Date((await pool.query('SELECT next_allowed_at FROM portal_notification_state')).rows[0].next_allowed_at).getTime() > Date.now() + 110_000);
  assert.equal((await worker()).calls, 0, 'Shared provider cooldown prevents any further requests.');
  await pool.query("UPDATE portal_notification_state SET next_allowed_at=NULL; UPDATE portal_users SET is_active=false WHERE id=2");
  await due();
  let firstKey, firstBody;
  await worker(async (_endpoint, init) => { firstKey = init.headers['Idempotency-Key']; firstBody = init.body; throw new Error('Synthetic ambiguous timeout'); });
  await due();
  await worker(async (_endpoint, init) => { assert.equal(init.headers['Idempotency-Key'], firstKey); assert.equal(init.body, firstBody); return Response.json({ id: crypto.randomUUID() }); });
  await due(); await worker(async () => Response.json({ last_event: 'bounced' }));
  assert.equal((await supplierAuthAlerts(pool))[0].email_failed, 1, 'Delivery failure is visible with the incident.');
  await resolveRenogyAuthFailure(pool); await recordRenogyAuthFailure(pool);
  await worker(async () => { throw new Error('Synthetic timeout'); });
  await pool.query("UPDATE supplier_auth_emails SET first_attempt_at=NOW()-interval '24 hours',next_attempt_at=NOW() WHERE state='pending'");
  assert.equal((await worker()).calls, 0, 'Do not retry outside provider idempotency retention.');
  await resolveRenogyAuthFailure(pool); await worker();
  assert.equal((await supplierAuthAlerts(pool)).length, 0);
  console.log('PASS: real Renogy job auth failure/renewal/cache/secrecy, incident dedup/recovery, active-admin emails, delivery checks, Retry-After, stable uncertain retries and retry expiry. No live provider calls.');
} finally {
  await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true });
  await pool.end(); await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await root.end();
}
