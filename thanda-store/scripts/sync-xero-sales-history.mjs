#!/usr/bin/env node

// Builds a small, derived cache for Home favourites. The portal never queries
// Xero while rendering a customer's catalogue.
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const TOKEN_URL = 'https://identity.xero.com/connect/token';
const INVOICES_URL = 'https://api.xero.com/api.xro/2.0/Invoices';
const INITIAL_WINDOW_DAYS = 365;
// Keep room below Xero's 60 requests/minute tenant limit for stock and contact
// jobs that share the same connection.
const REQUEST_INTERVAL_MS = 1_500;
const REQUEST_TIMEOUT_MS = 30_000;
let lastRequestAt = 0;

function required(name) { if (!process.env[name]) throw new Error(`${name} is required`); return process.env[name]; }
function isoDate(daysAgo = 0) { const date = new Date(Date.now() - daysAgo * 86_400_000); return date.toISOString().slice(0, 10); }

async function readToken(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function writeToken(file, token) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 }); }
async function usableToken(config, token) {
  if (token.access_token && Date.parse(token.expires_at || '') > Date.now() + 60_000) return token;
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const response = await fetch(TOKEN_URL, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Xero token refresh failed: ${payload.error || response.status}`);
  const updated = { ...token, ...payload, expires_at: new Date(Date.now() + Number(payload.expires_in || 0) * 1000).toISOString(), updated_at: new Date().toISOString() };
  await writeToken(config.tokenFile, updated); return updated;
}
function headers(token, extra = {}) { return { Authorization: `Bearer ${token.access_token}`, 'xero-tenant-id': token.tenant_id, Accept: 'application/json', ...extra }; }
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
async function xeroJson(url, token, extraHeaders = {}, usageClient) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const wait = Math.max(0, REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (wait) await sleep(wait);
    lastRequestAt = Date.now();
    let response;
    try {
      response = await fetch(url, {
        headers: headers(token, extraHeaders),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt < 3) {
        console.error(`Xero invoice request failed (${error instanceof Error ? error.name : 'unknown error'}); retrying in 30s (attempt ${attempt + 1}/3)`);
        await sleep(30_000);
        continue;
      }
      throw error;
    }
    const body = await response.text();
    await recordUsage(usageClient, response);
    if (response.status === 304) return { Invoices: [] };
    if (response.status === 429 && attempt < 3) {
      const retrySeconds = Math.max(5, Number(response.headers.get('retry-after')) || 30);
      if (response.headers.get('x-rate-limit-problem') === 'day') {
        const error = new Error(`Xero daily API allowance is exhausted; retry after ${retrySeconds}s`);
        error.code = 'XERO_DAILY_LIMIT';
        throw error;
      }
      console.error(`Xero rate limited invoice sync; retrying in ${retrySeconds}s (attempt ${attempt + 1}/3)`);
      await sleep(retrySeconds * 1_000);
      continue;
    }
    let payload = {};
    if (body.trim()) {
      try { payload = JSON.parse(body); }
      catch { throw new Error(`Xero invoices returned non-JSON: ${response.status} ${response.statusText} ${body.slice(0, 300)}`); }
    }
    if (!response.ok) throw new Error(`Xero invoices request failed: ${response.status} ${response.statusText} ${body.slice(0, 500)}`);
    if (!body.trim()) throw new Error(`Xero invoices returned an empty successful response: ${response.status} ${response.statusText}`);
    return payload;
  }
  throw new Error('Xero invoice request exceeded retry limit');
}
async function ensureSchema(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS xero_invoice_sync_state (id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id), last_successful_sync_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS xero_sales_invoice_lines (invoice_id TEXT NOT NULL, contact_id TEXT NOT NULL, invoice_date DATE NOT NULL, updated_at TIMESTAMPTZ NOT NULL, sku TEXT NOT NULL, quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0), PRIMARY KEY (invoice_id, sku))`);
  await client.query('CREATE INDEX IF NOT EXISTS xero_sales_invoice_lines_contact_date_idx ON xero_sales_invoice_lines (contact_id, invoice_date DESC)');
  await client.query('CREATE INDEX IF NOT EXISTS xero_sales_invoice_lines_sku_date_idx ON xero_sales_invoice_lines (sku, invoice_date DESC)');
  await client.query(`CREATE TABLE IF NOT EXISTS xero_api_usage (id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id), day_limit_remaining INTEGER, minute_limit_remaining INTEGER, app_minute_limit_remaining INTEGER, rate_limit_problem TEXT, retry_after_seconds INTEGER, next_allowed_at TIMESTAMPTZ, source TEXT, observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query('ALTER TABLE xero_api_usage ADD COLUMN IF NOT EXISTS next_allowed_at TIMESTAMPTZ');
}
function headerNumber(headers, name) { const value = Number(headers.get(name)); return Number.isFinite(value) ? value : null; }
async function recordUsage(client, response) {
  if (!client) return;
  await client.query(`
    INSERT INTO xero_api_usage (id, day_limit_remaining, minute_limit_remaining, app_minute_limit_remaining, rate_limit_problem, retry_after_seconds, next_allowed_at, source, observed_at)
    VALUES (true, $1, $2, $3, $4, $5, $6, 'sales-history', NOW())
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
    response.headers.get('x-rate-limit-problem'),
    headerNumber(response.headers, 'retry-after'),
    response.headers.get('x-rate-limit-problem') === 'day' && headerNumber(response.headers, 'retry-after')
      ? new Date(Date.now() + headerNumber(response.headers, 'retry-after') * 1_000).toISOString() : null,
  ]);
}
function invoiceDate(invoice) { return String(invoice.DateString || invoice.Date || '').slice(0, 10); }
async function cacheInvoice(client, invoice, stats) {
  const id = String(invoice.InvoiceID || '');
  if (!id) return;
  stats.invoices += 1;
  await client.query('DELETE FROM xero_sales_invoice_lines WHERE invoice_id = $1', [id]);
  const eligible = invoice.Type === 'ACCREC' && ['AUTHORISED', 'PAID'].includes(String(invoice.Status || '').toUpperCase());
  const date = invoiceDate(invoice);
  const contactId = String(invoice.Contact?.ContactID || '');
  if (!eligible || !date || !contactId || date < isoDate(INITIAL_WINDOW_DAYS)) return;
  stats.eligibleInvoices += 1;
  const quantities = new Map();
  for (const line of invoice.LineItems || []) {
    const sku = String(line.ItemCode || line.Item?.Code || '').trim().toUpperCase();
    const quantity = Number(line.Quantity);
    if (sku && Number.isFinite(quantity) && quantity > 0) quantities.set(sku, (quantities.get(sku) || 0) + quantity);
  }
  for (const [sku, quantity] of quantities) {
    await client.query('INSERT INTO xero_sales_invoice_lines (invoice_id, contact_id, invoice_date, updated_at, sku, quantity) VALUES ($1,$2,$3,NOW(),$4,$5)', [id, contactId, date, sku, quantity]);
    stats.cachedLines += 1;
  }
}

async function fetchInvoiceDetails(invoiceIds, token, usageClient) {
  const result = [];
  // Xero's collection endpoint does not support an InvoiceIDs batch parameter.
  // Fetch only the exceptional summaries that omitted line details by their
  // canonical resource URL; normal paged responses already include lines.
  for (const invoiceId of invoiceIds) {
    const payload = await xeroJson(`${INVOICES_URL}/${encodeURIComponent(invoiceId)}`, token, {}, usageClient);
    const invoice = Array.isArray(payload.Invoices) ? payload.Invoices[0] : null;
    if (!invoice || String(invoice.InvoiceID || '') !== invoiceId || !Array.isArray(invoice.LineItems)) {
      throw new Error(`Xero did not return complete detail for invoice ${invoiceId}`);
    }
    result.push(invoice);
  }
  return result;
}
async function main() {
  const config = { clientId: required('XERO_CLIENT_ID'), clientSecret: required('XERO_CLIENT_SECRET'), tokenFile: process.env.XERO_TOKEN_FILE || '/var/lib/thanda-store/xero-token.json' };
  let token = await usableToken(config, await readToken(config.tokenFile));
  if (!token.tenant_id) throw new Error('Xero token is missing tenant_id');
  if (!String(token.scope || '').split(/\s+/).includes('accounting.invoices')) throw new Error('Xero must be reconnected with accounting.invoices before invoice history can sync');
  const pool = new pg.Pool({ connectionString: required('DATABASE_URL') });
  const client = await pool.connect();
  const stats = { pages: 0, invoices: 0, eligibleInvoices: 0, cachedLines: 0 };
  try {
    await ensureSchema(client);
    const allowance = await client.query('SELECT next_allowed_at FROM xero_api_usage WHERE id = true');
    const nextAllowedAt = allowance.rows[0]?.next_allowed_at ? Date.parse(allowance.rows[0].next_allowed_at) : 0;
    if (nextAllowedAt > Date.now()) {
      console.log(`Xero sales history sync skipped until ${new Date(nextAllowedAt).toISOString()} after a daily rate limit response.`);
      return;
    }
    const state = await client.query('SELECT last_successful_sync_at FROM xero_invoice_sync_state WHERE id = true');
    const modifiedSince = state.rows[0]?.last_successful_sync_at;
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({ page: String(page), pageSize: '100', DateFrom: isoDate(INITIAL_WINDOW_DAYS), order: 'Date DESC' });
      const payload = await xeroJson(`${INVOICES_URL}?${query}`, token, modifiedSince ? { 'If-Modified-Since': new Date(modifiedSince).toUTCString() } : {}, client);
      const invoices = Array.isArray(payload.Invoices) ? payload.Invoices : [];
      stats.pages += 1;
      const summariesWithLines = invoices.filter((invoice) => Array.isArray(invoice.LineItems));
      const idsNeedingLines = invoices
        .filter((invoice) => !Array.isArray(invoice.LineItems))
        .map((invoice) => String(invoice.InvoiceID || ''))
        .filter(Boolean);
      const detailedInvoices = await fetchInvoiceDetails(idsNeedingLines, token, client);
      for (const invoice of [...summariesWithLines, ...detailedInvoices]) await cacheInvoice(client, invoice, stats);
      if (invoices.length === 0) break;
    }
    await client.query(`INSERT INTO xero_invoice_sync_state (id, last_successful_sync_at) VALUES (true, NOW()) ON CONFLICT (id) DO UPDATE SET last_successful_sync_at = EXCLUDED.last_successful_sync_at, updated_at = NOW()`);
    console.log(JSON.stringify(stats, null, 2));
  } catch (error) {
    if (error?.code === 'XERO_DAILY_LIMIT') {
      console.log(`${error.message}. Future timer runs will skip until the recorded reset time.`);
      return;
    }
    throw error;
  } finally { client.release(); await pool.end(); }
}
main().catch((error) => { console.error(error); process.exit(1); });
