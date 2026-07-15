#!/usr/bin/env node

// Xero expects webhook requests to return quickly. This worker is the only
// code that calls Xero after an event: it batches invoice IDs, handles one
// contact at a time, and leaves failed work queued for the next run.
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const TOKEN_URL = 'https://identity.xero.com/connect/token';
const ACCOUNTING_URL = 'https://api.xero.com/api.xro/2.0';
const INITIAL_WINDOW_DAYS = 365;
const REQUEST_INTERVAL_MS = 1_500;
// Xero's collection endpoint has no InvoiceIDs batch parameter. Each queued
// invoice must be fetched by its canonical resource URL, so cap the worker
// tightly rather than risking the daily tenant allowance on a burst.
const MAX_INVOICE_EVENTS_PER_RUN = 20;
const MAX_CONTACT_EVENTS_PER_RUN = 10;
const EXCLUDED_ADDITIONAL_PERSON_EMAILS = new Set(['sales@thanda.solar']);
let lastRequestAt = 0;

function required(name) { if (!process.env[name]) throw new Error(`${name} is required`); return process.env[name]; }
function isoDate(daysAgo = 0) { return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10); }
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function headerNumber(headers, name) { const value = Number(headers.get(name)); return Number.isFinite(value) ? value : null; }

async function readToken(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function writeToken(file, token) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
}
async function usableToken(config, token) {
  if (token.access_token && token.tenant_id && Date.parse(token.expires_at || '') > Date.now() + 60_000) return token;
  if (!token.refresh_token) throw new Error('Xero token file does not contain a refresh token');
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Xero token refresh failed: ${payload.error || response.status}`);
  const updated = { ...token, ...payload, expires_at: new Date(Date.now() + Number(payload.expires_in || 0) * 1000).toISOString(), updated_at: new Date().toISOString() };
  await writeToken(config.tokenFile, updated);
  return updated;
}

async function ensureSchema(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS xero_invoice_sync_state (id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id), last_successful_sync_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS xero_sales_invoice_lines (invoice_id TEXT NOT NULL, contact_id TEXT NOT NULL, invoice_date DATE NOT NULL, updated_at TIMESTAMPTZ NOT NULL, sku TEXT NOT NULL, quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0), PRIMARY KEY (invoice_id, sku))`);
  await client.query(`CREATE TABLE IF NOT EXISTS xero_api_usage (id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id), day_limit_remaining INTEGER, minute_limit_remaining INTEGER, app_minute_limit_remaining INTEGER, rate_limit_problem TEXT, retry_after_seconds INTEGER, next_allowed_at TIMESTAMPTZ, source TEXT, observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query('ALTER TABLE xero_api_usage ADD COLUMN IF NOT EXISTS next_allowed_at TIMESTAMPTZ');
  await client.query(`CREATE TABLE IF NOT EXISTS xero_webhook_events (id BIGSERIAL PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, event_category TEXT NOT NULL, event_type TEXT NOT NULL, resource_id TEXT NOT NULL, event_date_utc TIMESTAMPTZ, payload JSONB NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), processed_at TIMESTAMPTZ, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)`);
  await client.query('CREATE INDEX IF NOT EXISTS xero_webhook_events_pending_idx ON xero_webhook_events (received_at) WHERE processed_at IS NULL');
  await client.query('CREATE INDEX IF NOT EXISTS xero_sales_invoice_lines_contact_date_idx ON xero_sales_invoice_lines (contact_id, invoice_date DESC)');
  await client.query('CREATE INDEX IF NOT EXISTS xero_sales_invoice_lines_sku_date_idx ON xero_sales_invoice_lines (sku, invoice_date DESC)');
  await client.query("ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS xero_person_kind TEXT NOT NULL DEFAULT 'manual'");
  await client.query('ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS xero_person_email TEXT');
  await client.query('ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ');
  await client.query('CREATE INDEX IF NOT EXISTS portal_users_xero_person_idx ON portal_users (organisation_id, xero_person_kind)');
}

async function recordUsage(client, response) {
  const rateLimitProblem = response.headers.get('x-rate-limit-problem');
  const retryAfter = headerNumber(response.headers, 'retry-after');
  await client.query(`
    INSERT INTO xero_api_usage (id, day_limit_remaining, minute_limit_remaining, app_minute_limit_remaining, rate_limit_problem, retry_after_seconds, next_allowed_at, source, observed_at)
    VALUES (true, $1, $2, $3, $4, $5, $6, 'webhook-worker', NOW())
    ON CONFLICT (id) DO UPDATE SET
      day_limit_remaining = EXCLUDED.day_limit_remaining,
      minute_limit_remaining = EXCLUDED.minute_limit_remaining,
      app_minute_limit_remaining = EXCLUDED.app_minute_limit_remaining,
      rate_limit_problem = EXCLUDED.rate_limit_problem,
      retry_after_seconds = EXCLUDED.retry_after_seconds,
      next_allowed_at = EXCLUDED.next_allowed_at,
      source = EXCLUDED.source,
      observed_at = EXCLUDED.observed_at
  `, [
    headerNumber(response.headers, 'x-daylimit-remaining'),
    headerNumber(response.headers, 'x-minlimit-remaining'),
    headerNumber(response.headers, 'x-appminlimit-remaining'),
    rateLimitProblem,
    retryAfter,
    rateLimitProblem === 'day' && retryAfter ? new Date(Date.now() + retryAfter * 1_000).toISOString() : null,
  ]);
}

async function xeroJson(client, token, pathname) {
  const wait = Math.max(0, REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt));
  if (wait) await sleep(wait);
  lastRequestAt = Date.now();
  const response = await fetch(`${ACCOUNTING_URL}${pathname}`, {
    headers: { Authorization: `Bearer ${token.access_token}`, 'xero-tenant-id': token.tenant_id, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  await recordUsage(client, response);
  if (response.status === 429 && response.headers.get('x-rate-limit-problem') === 'day') {
    const error = new Error('Xero daily API allowance is exhausted');
    error.code = 'XERO_DAILY_LIMIT';
    throw error;
  }
  if (!response.ok) throw new Error(`Xero ${pathname} fetch failed: ${response.status} ${text.slice(0, 300)}`);
  return text.trim() ? JSON.parse(text) : {};
}

async function cacheInvoice(client, invoice, stats) {
  const invoiceId = String(invoice.InvoiceID || '');
  if (!invoiceId) return;
  await client.query('DELETE FROM xero_sales_invoice_lines WHERE invoice_id = $1', [invoiceId]);
  const date = String(invoice.DateString || invoice.Date || '').slice(0, 10);
  const contactId = String(invoice.Contact?.ContactID || '');
  const eligible = invoice.Type === 'ACCREC' && ['AUTHORISED', 'PAID'].includes(String(invoice.Status || '').toUpperCase());
  if (!eligible || !date || !contactId || date < isoDate(INITIAL_WINDOW_DAYS)) return;
  const quantities = new Map();
  for (const line of invoice.LineItems || []) {
    const sku = String(line.ItemCode || line.Item?.Code || '').trim().toUpperCase();
    const quantity = Number(line.Quantity);
    if (sku && Number.isFinite(quantity) && quantity > 0) quantities.set(sku, (quantities.get(sku) || 0) + quantity);
  }
  for (const [sku, quantity] of quantities) {
    await client.query('INSERT INTO xero_sales_invoice_lines (invoice_id, contact_id, invoice_date, updated_at, sku, quantity) VALUES ($1, $2, $3, NOW(), $4, $5)', [invoiceId, contactId, date, sku, quantity]);
    stats.cachedLines += 1;
  }
}

async function reconcileContact(client, token, contactId, stats) {
  const payload = await xeroJson(client, token, `/Contacts/${encodeURIComponent(contactId)}`);
  const contact = payload.Contacts?.[0];
  const archived = !contact || String(contact.ContactStatus || '').toUpperCase() === 'ARCHIVED';
  const contactName = archived ? '' : String(contact.Name || '').trim();
  const emails = archived ? new Set() : new Set([
    String(contact.EmailAddress || '').trim().toLowerCase(),
    ...(contact.ContactPersons || []).map((person) => String(person.EmailAddress || '').trim().toLowerCase()),
  ].filter((email) => email && !EXCLUDED_ADDITIONAL_PERSON_EMAILS.has(email)));
  if (contactName) await client.query('UPDATE organisations SET name = $2, xero_contact_name = $2, updated_at = NOW() WHERE xero_contact_id = $1', [contactId, contactName]);
  const users = await client.query(`
    SELECT u.id, u.xero_person_email
    FROM portal_users u JOIN organisations o ON o.id = u.organisation_id
    WHERE o.xero_contact_id = $1 AND u.is_active = true AND u.xero_person_kind IN ('primary', 'additional')
  `, [contactId]);
  const missingIds = users.rows
    .filter((user) => !emails.has(String(user.xero_person_email || '').toLowerCase()))
    .map((user) => Number(user.id));
  if (missingIds.length) {
    await client.query('BEGIN');
    try {
      await client.query('UPDATE portal_users SET is_active = false, archived_at = NOW(), updated_at = NOW() WHERE id = ANY($1::bigint[])', [missingIds]);
      await client.query('DELETE FROM portal_sessions WHERE user_id = ANY($1::bigint[])', [missingIds]);
      await client.query('UPDATE login_otps SET consumed_at = NOW() WHERE user_id = ANY($1::bigint[]) AND consumed_at IS NULL', [missingIds]);
      await client.query('UPDATE account_setup_tokens SET consumed_at = NOW() WHERE user_id = ANY($1::bigint[]) AND consumed_at IS NULL', [missingIds]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    stats.archivedUsers += missingIds.length;
  }
  stats.contacts += 1;
}

async function markProcessed(client, ids) {
  if (!ids.length) return;
  await client.query('UPDATE xero_webhook_events SET processed_at = NOW(), attempts = attempts + 1, last_error = NULL WHERE id = ANY($1::bigint[])', [ids]);
}
async function markFailure(client, ids, error) {
  if (!ids.length) return;
  await client.query('UPDATE xero_webhook_events SET attempts = attempts + 1, last_error = $2 WHERE id = ANY($1::bigint[])', [ids, String(error instanceof Error ? error.message : error).slice(0, 1000)]);
}

async function main() {
  const config = { clientId: required('XERO_CLIENT_ID'), clientSecret: required('XERO_CLIENT_SECRET'), tokenFile: process.env.XERO_TOKEN_FILE || '/var/lib/thanda-store/xero-token.json' };
  const pool = new pg.Pool({ connectionString: required('DATABASE_URL') });
  const client = await pool.connect();
  const stats = { invoices: 0, cachedLines: 0, contacts: 0, archivedUsers: 0 };
  try {
    await ensureSchema(client);
    const lock = await client.query('SELECT pg_try_advisory_lock(742032) AS locked');
    if (!lock.rows[0]?.locked) { console.log('Another Xero webhook worker is already running.'); return; }
    try {
      const allowance = await client.query('SELECT next_allowed_at FROM xero_api_usage WHERE id = true');
      const nextAllowedAt = Date.parse(allowance.rows[0]?.next_allowed_at || '');
      if (Number.isFinite(nextAllowedAt) && nextAllowedAt > Date.now()) {
        console.log(`Xero webhook worker skipped until ${new Date(nextAllowedAt).toISOString()} after a daily rate limit response.`);
        return;
      }
      const token = await usableToken(config, await readToken(config.tokenFile));
      if (!token.tenant_id) throw new Error('Xero token is missing tenant_id');
      if (!String(token.scope || '').split(/\s+/).includes('accounting.invoices')) throw new Error('Xero must be reconnected with accounting.invoices before webhook events can sync');

      const invoiceEvents = await client.query(`
        SELECT id, resource_id FROM xero_webhook_events
        WHERE processed_at IS NULL AND tenant_id = $1 AND event_category = 'INVOICE'
        ORDER BY received_at ASC LIMIT $2
      `, [token.tenant_id, MAX_INVOICE_EVENTS_PER_RUN]);
      const eventsByInvoice = new Map();
      for (const event of invoiceEvents.rows) eventsByInvoice.set(String(event.resource_id), [...(eventsByInvoice.get(String(event.resource_id)) || []), Number(event.id)]);
      for (const invoiceId of eventsByInvoice.keys()) {
        const eventIds = eventsByInvoice.get(invoiceId) || [];
        try {
          const payload = await xeroJson(client, token, `/Invoices/${encodeURIComponent(invoiceId)}`);
          const invoice = payload.Invoices?.[0];
          if (!invoice || String(invoice.InvoiceID || '') !== invoiceId || !Array.isArray(invoice.LineItems)) {
            throw new Error(`Xero did not return complete detail for invoice ${invoiceId}`);
          }
          await cacheInvoice(client, invoice, stats);
          stats.invoices += 1;
          await markProcessed(client, eventIds);
        } catch (error) {
          if (error?.code === 'XERO_DAILY_LIMIT') throw error;
          await markFailure(client, eventIds, error);
        }
      }

      const contactEvents = await client.query(`
        SELECT DISTINCT ON (resource_id) id, resource_id FROM xero_webhook_events
        WHERE processed_at IS NULL AND tenant_id = $1 AND event_category = 'CONTACT'
        ORDER BY resource_id, received_at DESC LIMIT $2
      `, [token.tenant_id, MAX_CONTACT_EVENTS_PER_RUN]);
      for (const event of contactEvents.rows) {
        const related = await client.query(`
          SELECT id FROM xero_webhook_events WHERE processed_at IS NULL AND tenant_id = $1 AND event_category = 'CONTACT' AND resource_id = $2
        `, [token.tenant_id, event.resource_id]);
        const eventIds = related.rows.map((row) => Number(row.id));
        try {
          await reconcileContact(client, token, String(event.resource_id), stats);
          await markProcessed(client, eventIds);
        } catch (error) {
          if (error?.code === 'XERO_DAILY_LIMIT') throw error;
          await markFailure(client, eventIds, error);
        }
      }
      console.log(JSON.stringify(stats, null, 2));
    } finally {
      await client.query('SELECT pg_advisory_unlock(742032)');
    }
  } catch (error) {
    if (error?.code === 'XERO_DAILY_LIMIT') {
      console.log('Xero webhook worker paused until the recorded daily-limit reset time.');
      return;
    }
    throw error;
  } finally { client.release(); await pool.end(); }
}

main().catch((error) => { console.error(error); process.exit(1); });
