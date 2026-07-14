#!/usr/bin/env node

// Builds a small, derived cache for Home favourites. The portal never queries
// Xero while rendering a customer's catalogue.
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const TOKEN_URL = 'https://identity.xero.com/connect/token';
const INVOICES_URL = 'https://api.xero.com/api.xro/2.0/Invoices';
const INITIAL_WINDOW_DAYS = 365;
const REQUEST_INTERVAL_MS = 1_100;
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
async function xeroJson(url, token, extraHeaders = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const wait = Math.max(0, REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (wait) await sleep(wait);
    lastRequestAt = Date.now();
    const response = await fetch(url, { headers: headers(token, extraHeaders) });
    const body = await response.text();
    if (response.status === 429 && attempt < 3) {
      const retrySeconds = Math.max(5, Number(response.headers.get('retry-after')) || 30);
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
}
function invoiceDate(invoice) { return String(invoice.DateString || invoice.Date || '').slice(0, 10); }
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
    const state = await client.query('SELECT last_successful_sync_at FROM xero_invoice_sync_state WHERE id = true');
    const modifiedSince = state.rows[0]?.last_successful_sync_at;
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({ page: String(page), DateFrom: isoDate(INITIAL_WINDOW_DAYS) });
      const payload = await xeroJson(`${INVOICES_URL}?${query}`, token, modifiedSince ? { 'If-Modified-Since': new Date(modifiedSince).toUTCString() } : {});
      const invoices = Array.isArray(payload.Invoices) ? payload.Invoices : [];
      stats.pages += 1;
      for (const summary of invoices) {
        const id = String(summary.InvoiceID || '');
        if (!id) continue;
        const detail = (await xeroJson(`${INVOICES_URL}/${encodeURIComponent(id)}`, token)).Invoices?.[0];
        if (!detail) continue;
        stats.invoices += 1;
        await client.query('DELETE FROM xero_sales_invoice_lines WHERE invoice_id = $1', [id]);
        const eligible = detail.Type === 'ACCREC' && ['AUTHORISED', 'PAID'].includes(String(detail.Status || '').toUpperCase());
        const date = invoiceDate(detail);
        const contactId = String(detail.Contact?.ContactID || '');
        if (!eligible || !date || !contactId || date < isoDate(INITIAL_WINDOW_DAYS)) continue;
        stats.eligibleInvoices += 1;
        const quantities = new Map();
        for (const line of detail.LineItems || []) {
          const sku = String(line.ItemCode || line.Item?.Code || '').trim().toUpperCase();
          const quantity = Number(line.Quantity);
          if (sku && Number.isFinite(quantity) && quantity > 0) quantities.set(sku, (quantities.get(sku) || 0) + quantity);
        }
        for (const [sku, quantity] of quantities) {
          await client.query(`INSERT INTO xero_sales_invoice_lines (invoice_id, contact_id, invoice_date, updated_at, sku, quantity) VALUES ($1,$2,$3,NOW(),$4,$5)`, [id, contactId, date, sku, quantity]);
          stats.cachedLines += 1;
        }
      }
      if (invoices.length === 0) break;
    }
    await client.query(`INSERT INTO xero_invoice_sync_state (id, last_successful_sync_at) VALUES (true, NOW()) ON CONFLICT (id) DO UPDATE SET last_successful_sync_at = EXCLUDED.last_successful_sync_at, updated_at = NOW()`);
    console.log(JSON.stringify(stats, null, 2));
  } finally { client.release(); await pool.end(); }
}
main().catch((error) => { console.error(error); process.exit(1); });
