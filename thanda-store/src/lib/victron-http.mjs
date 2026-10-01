import { createHash, randomUUID } from 'node:crypto';

export const CATALOGUE_INTERVAL_MS = 4 * 60 * 60_000;
export function nextCatalogueRun(now = Date.now()) {
  return new Date((Math.floor((now + 15 * 60_000) / CATALOGUE_INTERVAL_MS) + 1) * CATALOGUE_INTERVAL_MS);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function accountKey(apiKey, apiRoot) {
  return createHash('sha256').update(`${new URL(apiRoot).origin}:${apiKey}`).digest('hex');
}
export function retryDeadline(value, now = Date.now()) {
  const seconds = Number(value);
  if (value !== null && String(value).trim() && Number.isFinite(seconds) && seconds >= 0)
    return new Date(now + seconds * 1000);
  const date = Date.parse(value || '');
  return new Date(Number.isFinite(date) ? Math.max(now, date) : now + 60 * 60_000);
}
export function requestKind(url) {
  const path = new URL(url).pathname;
  if (path.includes('/tracktrace/')) return { scope: 'tracking', endpoint: 'tracking-page' };
  if (/\/api\/v1\/products-extended\//.test(path)) return { scope: 'catalogue', endpoint: 'product-extended' };
  if (/\/api\/v1\/products\//.test(path)) return { scope: 'catalogue', endpoint: 'products' };
  if (path.includes('/orders/shipments/')) return { scope: 'orders', endpoint: 'shipments' };
  if (path.includes('/orders/backorders/')) return { scope: 'orders', endpoint: 'backorders' };
  return { scope: 'orders', endpoint: 'invoice-products' };
}
// Persist only fixed categories. Fetch errors can contain supplier URLs and
// request details, so their raw messages must not enter the usage ledger.
export function transportErrorKind(error, signal, phase = 'request') {
  if (signal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'timeout';
  const causes = [error, error?.cause, error?.cause?.cause].filter(Boolean);
  const codes = causes.map(cause => String(cause.code || '').toUpperCase());
  const messages = causes.map(cause => String(cause.message || '').toLowerCase());
  if (codes.some(code => code.includes('REDIRECT')) || messages.some(message => /redirect/.test(message))) return 'redirect_refused';
  if (codes.some(code => ['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL'].includes(code))) return 'dns';
  if (codes.some(code => code.startsWith('ERR_TLS') || code.startsWith('CERT_') || code.includes('SSL'))
      || messages.some(message => /certificate|tls handshake/.test(message))) return 'tls';
  if (codes.some(code => ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code))) return 'connection';
  return phase === 'response_body' ? 'response_body' : 'request_failed';
}
export class VictronPaused extends Error {
  constructor(until, reason = 'cooldown') {
    super(`Victron ${reason}: next permitted attempt ${new Date(until).toISOString()}.`);
    this.retryAt = new Date(until).toISOString();
    this.retryAfterSeconds = Math.max(0, Math.ceil((new Date(until).getTime() - Date.now()) / 1000));
  }
}
export async function ensureVictronHttpSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS victron_http_state (
    account TEXT NOT NULL, scope TEXT NOT NULL, blocked_until TIMESTAMPTZ,
    next_request_at TIMESTAMPTZ, last_status INTEGER, quota JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(account,scope))`);
  await db.query(`CREATE TABLE IF NOT EXISTS victron_http_usage (
    id BIGSERIAL PRIMARY KEY, account TEXT NOT NULL, requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    component TEXT NOT NULL, trigger TEXT NOT NULL, run_id TEXT NOT NULL,
    scope TEXT NOT NULL, endpoint TEXT NOT NULL, status INTEGER, outcome TEXT NOT NULL,
    duration_ms INTEGER, retry_at TIMESTAMPTZ)`);
  await db.query(`CREATE INDEX IF NOT EXISTS victron_http_usage_time ON victron_http_usage(requested_at)`);
  await db.query('ALTER TABLE victron_http_usage ADD COLUMN IF NOT EXISTS error_kind TEXT');
  await db.query(`CREATE TABLE IF NOT EXISTS victron_catalogue_schedule (
    id BOOLEAN PRIMARY KEY DEFAULT true CHECK(id), last_attempt_at TIMESTAMPTZ,
    next_scheduled_at TIMESTAMPTZ)`);
  await db.query(`CREATE TABLE IF NOT EXISTS victron_tracking_cache (
    source_url TEXT PRIMARY KEY, resolved_url TEXT, checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved BOOLEAN NOT NULL DEFAULT false)`);
}

// One client for every production request path. PostgreSQL serialises request
// starts across web/CLI processes and retains cooldowns across restarts.
export function createVictronHttp({ pool, apiKey, apiRoot, component, trigger = 'scheduled',
  fetchImpl = fetch, timeoutMs = 20_000, maxRequests = 80 }) {
  const account = accountKey(apiKey, apiRoot);
  const runId = randomUUID();
  let calls = 0;
  let ready;
  async function request(url, options = {}) {
    if (new URL(url).origin !== new URL(apiRoot).origin || new URL(url).protocol !== 'https:')
      throw new Error('Refused unexpected Victron request origin.');
    if (++calls > maxRequests) throw new Error('Victron per-run request safety limit reached; resume at the next scheduled run.');
    await (ready ||= ensureVictronHttpSchema(pool));
    const { scope, endpoint } = requestKind(url);
    const db = await pool.connect();
    let locked = false;
    let ledgerId;
    let transportKind = null;
    const started = Date.now();
    try {
      // Avoid an unbounded wait when another process is holding the request lock.
      while (!locked && Date.now() - started < 30_000) {
        locked = (await db.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [`victron-http:${account}`])).rows[0]?.locked;
        if (!locked) await delay(100);
      }
      if (!locked) throw new Error('Victron request controller busy; retry later.');
      const state = (await db.query(`SELECT * FROM victron_http_state WHERE account=$1 AND scope IN ($2,'account')`, [account, scope])).rows;
      const blocked = Math.max(0, ...state.map(row => new Date(row.blocked_until || 0).getTime()));
      if (blocked > Date.now()) {
        await db.query(`INSERT INTO victron_http_usage(account,component,trigger,run_id,scope,endpoint,outcome,retry_at)
          VALUES($1,$2,$3,$4,$5,$6,'skipped',$7)`, [account, component, trigger, runId, scope, endpoint, new Date(blocked)]);
        throw new VictronPaused(blocked);
      }
      const pace = Math.max(0, ...state.map(row => new Date(row.next_request_at || 0).getTime())) - Date.now();
      if (pace > 5000) throw new VictronPaused(Date.now() + pace, 'pacing');
      if (pace > 0) await delay(pace);
      ledgerId = (await db.query(`INSERT INTO victron_http_usage(account,component,trigger,run_id,scope,endpoint,outcome)
        VALUES($1,$2,$3,$4,$5,$6,'started') RETURNING id`, [account, component, trigger, runId, scope, endpoint])).rows[0].id;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 30_000));
      let response, body;
      let phase = 'request';
      try {
        response = await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal,
          headers: { Accept: scope === 'tracking' ? 'text/html' : 'application/json',
            ...(scope !== 'tracking' ? { Authorization: apiKey } : {}), 'User-Agent': `ThandaStore/${component}` } });
        phase = 'response_body';
        body = await response.text();
      } catch (error) {
        transportKind = transportErrorKind(error, controller.signal, phase);
        throw error;
      } finally { clearTimeout(timer); }
      const quota = {};
      for (const [key, value] of response.headers) {
        if (/^(x-)?ratelimit[-a-z]*$|^retry-after$/.test(key)) quota[key] = value.slice(0, 120);
      }
      const retryAt = response.status === 429 ? retryDeadline(response.headers.get('retry-after')) : null;
      await db.query(`INSERT INTO victron_http_state(account,scope,blocked_until,last_status,quota)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(account,scope) DO UPDATE SET
        blocked_until=CASE WHEN $3::timestamptz IS NOT NULL THEN GREATEST(victron_http_state.blocked_until,$3) ELSE victron_http_state.blocked_until END,
        last_status=$4,quota=$5,updated_at=NOW()`, [account, scope, retryAt, response.status, JSON.stringify(quota)]);
      await db.query(`INSERT INTO victron_http_state(account,scope,next_request_at,blocked_until)
        VALUES($1,'account',NOW()+INTERVAL '1 second',$2) ON CONFLICT(account,scope) DO UPDATE SET
        next_request_at=EXCLUDED.next_request_at,blocked_until=GREATEST(victron_http_state.blocked_until,EXCLUDED.blocked_until)`,
      [account, process.env.VICTRON_ACCOUNT_WIDE_COOLDOWN === '1' ? retryAt : null]);
      await db.query(`UPDATE victron_http_usage SET status=$2,outcome=$3,duration_ms=$4,retry_at=$5 WHERE id=$1`,
        [ledgerId, response.status, response.ok ? 'success' : 'http_error', Date.now() - started, retryAt]);
      ledgerId = null;
      if (retryAt) throw new VictronPaused(retryAt, 'HTTP 429 cooldown');
      // Return a buffered response so the timeout covers the body as well.
      return new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, headers: response.headers });
    } catch (error) {
      if (ledgerId) await db.query(`UPDATE victron_http_usage SET outcome=$2,error_kind=$3,duration_ms=$4 WHERE id=$1`,
        [ledgerId, transportKind ? 'transport_error' : 'internal_error', transportKind, Date.now() - started]);
      throw error;
    } finally {
      if (locked) await db.query('SELECT pg_advisory_unlock(hashtext($1))', [`victron-http:${account}`]);
      db.release();
    }
  }
  return { request, account, get calls() { return calls; } };
}

export async function victronUsage(db) {
  await ensureVictronHttpSchema(db);
  const [states, usage, recent, schedule] = await Promise.all([
    db.query('SELECT scope,blocked_until,last_status,quota,updated_at FROM victron_http_state'),
    db.query(`SELECT component,trigger,scope,endpoint,COUNT(*) FILTER(WHERE outcome<>'skipped')::int AS requests,
      COUNT(*) FILTER(WHERE status=429)::int AS throttled,COUNT(*) FILTER(WHERE outcome='skipped')::int AS skipped
      FROM victron_http_usage WHERE requested_at>NOW()-INTERVAL '24 hours' GROUP BY component,trigger,scope,endpoint ORDER BY component,endpoint`),
    db.query(`SELECT requested_at,component,endpoint,status,outcome,error_kind,retry_at FROM victron_http_usage
      WHERE status=429 OR outcome IN ('transport_error','internal_error') ORDER BY requested_at DESC LIMIT 10`),
    db.query('SELECT last_attempt_at,next_scheduled_at FROM victron_catalogue_schedule WHERE id=true'),
  ]);
  return { checkedAt: new Date().toISOString(), states: states.rows, usage: usage.rows, recent: recent.rows, schedule: schedule.rows[0] || null };
}
