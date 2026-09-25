#!/usr/bin/env node

// Builds a small, derived cache for Home favourites. The portal never queries
// Xero while rendering a customer's catalogue.
import { hubFetch, hubStatus, assertHubSnapshot } from '../src/lib/xero/hub.mjs';
import pg from 'pg';

const INVOICES_URL = '/Invoices';
const CREDIT_NOTES_URL = '/CreditNotes';
const INITIAL_WINDOW_DAYS = 365;
// These jobs project stored Hub data and consume no Xero allowance.

function required(name) { if (!process.env[name]) throw new Error(`${name} is required`); return process.env[name]; }
function isoDate(daysAgo = 0) { const date = new Date(Date.now() - daysAgo * 86_400_000); return date.toISOString().slice(0, 10); }

async function xeroJson(url) {
  const response = await hubFetch(url);
  if (!response.ok) throw new Error(`Xero Hub evidence unavailable (${response.status})`);
  return response.json();
}
async function ensureSchema(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS xero_invoice_sync_state (id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id), last_successful_sync_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS xero_credit_note_sync_state (id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id), last_successful_sync_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS xero_sales_invoice_lines (invoice_id TEXT NOT NULL, contact_id TEXT NOT NULL, invoice_date DATE NOT NULL, updated_at TIMESTAMPTZ NOT NULL, sku TEXT NOT NULL, quantity NUMERIC(14,3) NOT NULL CHECK (quantity <> 0), PRIMARY KEY (invoice_id, sku))`);
  await client.query('ALTER TABLE xero_sales_invoice_lines DROP CONSTRAINT IF EXISTS xero_sales_invoice_lines_quantity_check');
  await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'xero_sales_invoice_lines'::regclass AND conname = 'xero_sales_invoice_lines_quantity_nonzero_check') THEN ALTER TABLE xero_sales_invoice_lines ADD CONSTRAINT xero_sales_invoice_lines_quantity_nonzero_check CHECK (quantity <> 0); END IF; END $$`);
  await client.query('CREATE INDEX IF NOT EXISTS xero_sales_invoice_lines_contact_date_idx ON xero_sales_invoice_lines (contact_id, invoice_date DESC)');
  await client.query('CREATE INDEX IF NOT EXISTS xero_sales_invoice_lines_sku_date_idx ON xero_sales_invoice_lines (sku, invoice_date DESC)');
  await client.query(`CREATE TABLE IF NOT EXISTS xero_api_usage (id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id), day_limit_remaining INTEGER, minute_limit_remaining INTEGER, app_minute_limit_remaining INTEGER, rate_limit_problem TEXT, retry_after_seconds INTEGER, next_allowed_at TIMESTAMPTZ, source TEXT, observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query('ALTER TABLE xero_api_usage ADD COLUMN IF NOT EXISTS next_allowed_at TIMESTAMPTZ');
}

function invoiceDate(invoice) { return String(invoice.DateString || invoice.Date || '').slice(0, 10); }

async function cacheCreditNote(client, creditNote, stats) {
  const id = String(creditNote.CreditNoteID || '');
  if (!id) return;
  stats.creditNotes += 1;
  await client.query('DELETE FROM xero_sales_invoice_lines WHERE invoice_id = $1', [id]);
  const eligible = creditNote.Type === 'ACCRECCREDIT' && ['AUTHORISED', 'PAID'].includes(String(creditNote.Status || '').toUpperCase());
  const date = invoiceDate(creditNote);
  const contactId = String(creditNote.Contact?.ContactID || '');
  if (!eligible || !date || !contactId || date < isoDate(INITIAL_WINDOW_DAYS)) return;
  stats.eligibleCreditNotes += 1;
  const quantities = new Map();
  for (const line of creditNote.LineItems || []) {
    const sku = String(line.ItemCode || line.Item?.Code || '').trim().toUpperCase();
    const quantity = Number(line.Quantity);
    if (sku && Number.isFinite(quantity) && quantity > 0) quantities.set(sku, (quantities.get(sku) || 0) - quantity);
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
async function fetchCreditNoteDetails(creditNoteIds, token, usageClient) {
  const result = [];
  for (const creditNoteId of creditNoteIds) {
    const payload = await xeroJson(`${CREDIT_NOTES_URL}/${encodeURIComponent(creditNoteId)}`, token, {}, usageClient);
    const creditNote = Array.isArray(payload.CreditNotes) ? payload.CreditNotes[0] : null;
    if (!creditNote || String(creditNote.CreditNoteID || '') !== creditNoteId || !Array.isArray(creditNote.LineItems)) {
      throw new Error(`Xero did not return complete detail for credit note ${creditNoteId}`);
    }
    result.push(creditNote);
  }
  return result;
}
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
async function main() {
  const token = await hubStatus();
  if (!token.tenant_id) throw new Error('Xero token is missing tenant_id');
  if (!String(token.scope || '').split(/\s+/).includes('accounting.invoices')) throw new Error('Xero must be reconnected with accounting.invoices before invoice history can sync');
  const pool = new pg.Pool({ connectionString: required('DATABASE_URL') });
  const client = await pool.connect();
  const stats = { pages: 0, invoices: 0, eligibleInvoices: 0, creditNotes: 0, eligibleCreditNotes: 0, cachedLines: 0 };
  try {
    await ensureSchema(client);
    await client.query('BEGIN');
    let invoiceSnapshot;
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({ page: String(page), pageSize: '100', DateFrom: isoDate(INITIAL_WINDOW_DAYS), order: 'Date DESC' });
      const payload = await xeroJson(`${INVOICES_URL}?${query}`, token);
      invoiceSnapshot = assertHubSnapshot(payload, invoiceSnapshot);
      if (page > 1000) throw new Error("Invoice page limit exceeded");
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
    let creditSnapshot;
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({ page: String(page), pageSize: '100', DateFrom: isoDate(INITIAL_WINDOW_DAYS), order: 'Date DESC' });
      const payload = await xeroJson(`${CREDIT_NOTES_URL}?${query}`, token);
      creditSnapshot = assertHubSnapshot(payload, creditSnapshot);
      if (page > 1000) throw new Error("Credit note page limit exceeded");
      const creditNotes = Array.isArray(payload.CreditNotes) ? payload.CreditNotes : [];
      stats.pages += 1;
      const summariesWithLines = creditNotes.filter((creditNote) => Array.isArray(creditNote.LineItems));
      const idsNeedingLines = creditNotes
        .filter((creditNote) => !Array.isArray(creditNote.LineItems))
        .map((creditNote) => String(creditNote.CreditNoteID || ''))
        .filter(Boolean);
      const detailedCreditNotes = await fetchCreditNoteDetails(idsNeedingLines, token, client);
      for (const creditNote of [...summariesWithLines, ...detailedCreditNotes]) await cacheCreditNote(client, creditNote, stats);
      if (creditNotes.length === 0) break;
    }
    await client.query(`INSERT INTO xero_invoice_sync_state (id, last_successful_sync_at) VALUES (true, NOW()) ON CONFLICT (id) DO UPDATE SET last_successful_sync_at = EXCLUDED.last_successful_sync_at, updated_at = NOW()`);
    await client.query(`INSERT INTO xero_credit_note_sync_state (id, last_successful_sync_at) VALUES (true, NOW()) ON CONFLICT (id) DO UPDATE SET last_successful_sync_at = EXCLUDED.last_successful_sync_at, updated_at = NOW()`);
    await client.query('COMMIT');
    console.log(JSON.stringify(stats, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.code === 'XERO_DAILY_LIMIT') {
      console.log(`${error.message}. Future timer runs will skip until the recorded reset time.`);
      return;
    }
    throw error;
  } finally { client.release(); await pool.end(); }
}
main().catch((error) => { console.error(error); process.exit(1); });
