#!/usr/bin/env node

// Projects completed Hub webhook evidence into portal sales and access state.
// It makes no Xero calls and leaves unfinished Hub events queued for retry.
import { hubFetch, hubStatus } from '../src/lib/xero/hub.mjs';
import pg from 'pg';

const INITIAL_WINDOW_DAYS = 365;
// Bound local projection work per timer run.
const MAX_INVOICE_EVENTS_PER_RUN = 20;
const MAX_CONTACT_EVENTS_PER_RUN = 10;
const EXCLUDED_ADDITIONAL_PERSON_EMAILS = new Set(['sales@thanda.solar']);

function required(name) { if (!process.env[name]) throw new Error(`${name} is required`); return process.env[name]; }
function isoDate(daysAgo = 0) { return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10); }


async function xeroJson(client, token, pathname) {
  const response = await hubFetch(pathname);
  if (!response.ok) throw new Error(`Xero Hub evidence unavailable (${response.status})`);
  return response.json();
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

async function cacheCreditNote(client, creditNote, stats) {
  const creditNoteId = String(creditNote.CreditNoteID || '');
  if (!creditNoteId) return;
  await client.query('DELETE FROM xero_sales_invoice_lines WHERE invoice_id = $1', [creditNoteId]);
  const date = String(creditNote.DateString || creditNote.Date || '').slice(0, 10);
  const contactId = String(creditNote.Contact?.ContactID || '');
  const eligible = creditNote.Type === 'ACCRECCREDIT' && ['AUTHORISED', 'PAID'].includes(String(creditNote.Status || '').toUpperCase());
  if (!eligible || !date || !contactId || date < isoDate(INITIAL_WINDOW_DAYS)) return;
  const quantities = new Map();
  for (const line of creditNote.LineItems || []) {
    const sku = String(line.ItemCode || line.Item?.Code || '').trim().toUpperCase();
    const quantity = Number(line.Quantity);
    if (sku && Number.isFinite(quantity) && quantity > 0) quantities.set(sku, (quantities.get(sku) || 0) - quantity);
  }
  for (const [sku, quantity] of quantities) {
    await client.query('INSERT INTO xero_sales_invoice_lines (invoice_id, contact_id, invoice_date, updated_at, sku, quantity) VALUES ($1, $2, $3, NOW(), $4, $5)', [creditNoteId, contactId, date, sku, quantity]);
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

async function ensureSchema(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS xero_invoice_sync_state (id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id), last_successful_sync_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS xero_sales_invoice_lines (invoice_id TEXT NOT NULL, contact_id TEXT NOT NULL, invoice_date DATE NOT NULL, updated_at TIMESTAMPTZ NOT NULL, sku TEXT NOT NULL, quantity NUMERIC(14,3) NOT NULL CHECK (quantity <> 0), PRIMARY KEY (invoice_id, sku))`);
  await client.query('ALTER TABLE xero_sales_invoice_lines DROP CONSTRAINT IF EXISTS xero_sales_invoice_lines_quantity_check');
  await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'xero_sales_invoice_lines'::regclass AND conname = 'xero_sales_invoice_lines_quantity_nonzero_check') THEN ALTER TABLE xero_sales_invoice_lines ADD CONSTRAINT xero_sales_invoice_lines_quantity_nonzero_check CHECK (quantity <> 0); END IF; END $$`);
  await client.query(`CREATE TABLE IF NOT EXISTS xero_api_usage (id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id), day_limit_remaining INTEGER, minute_limit_remaining INTEGER, app_minute_limit_remaining INTEGER, rate_limit_problem TEXT, retry_after_seconds INTEGER, next_allowed_at TIMESTAMPTZ, source TEXT, observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS xero_stock_sync_state (id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id), refresh_requested_at TIMESTAMPTZ, last_started_at TIMESTAMPTZ, last_completed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query('INSERT INTO xero_stock_sync_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING');
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
async function main() {
  const pool = new pg.Pool({ connectionString: required('DATABASE_URL') });
  const client = await pool.connect();
  const stats = { invoices: 0, creditNotes: 0, cachedLines: 0, contacts: 0, archivedUsers: 0, stockRefreshRequested: false };
  try {
    await ensureSchema(client);
    const lock = await client.query('SELECT pg_try_advisory_lock(742032) AS locked');
    if (!lock.rows[0]?.locked) { console.log('Another Xero webhook worker is already running.'); return; }
    try {
      const workerBudget = MAX_INVOICE_EVENTS_PER_RUN;
      const token = await hubStatus();
      if (!token.tenant_id) throw new Error('Xero token is missing tenant_id');
      if (!String(token.scope || '').split(/\s+/).includes('accounting.invoices')) throw new Error('Xero must be reconnected with accounting.invoices before webhook events can sync');

      const invoiceEvents = await client.query(`
        SELECT id, resource_id, event_category FROM xero_webhook_events
        WHERE processed_at IS NULL AND tenant_id = $1 AND event_category IN ('INVOICE', 'CREDITNOTE')
        ORDER BY received_at ASC LIMIT $2
      `, [token.tenant_id, workerBudget]);
      const eventsByInvoice = new Map();
      for (const event of invoiceEvents.rows) {
        const key = `${event.event_category}:${event.resource_id}`;
        eventsByInvoice.set(key, [...(eventsByInvoice.get(key) || []), Number(event.id)]);
      }
      for (const [key, eventIds] of eventsByInvoice.entries()) {
        const [category, resourceId] = key.split(':', 2);
        try {
          const creditNote = category === 'CREDITNOTE';
          const payload = await xeroJson(client, token, `/${creditNote ? 'CreditNotes' : 'Invoices'}/${encodeURIComponent(resourceId)}`);
          const document = creditNote ? payload.CreditNotes?.[0] : payload.Invoices?.[0];
          const documentId = creditNote ? document?.CreditNoteID : document?.InvoiceID;
          if (!document || String(documentId || '') !== resourceId || !Array.isArray(document.LineItems)) {
            throw new Error(`Xero did not return complete detail for ${creditNote ? 'credit note' : 'invoice'} ${resourceId}`);
          }
          if (creditNote) {
            await cacheCreditNote(client, document, stats);
            stats.creditNotes += 1;
          } else {
            await cacheInvoice(client, document, stats);
            stats.invoices += 1;
          }
          if (['ACCREC', 'ACCRECCREDIT'].includes(String(document.Type || '').toUpperCase())) {
            await client.query('UPDATE xero_stock_sync_state SET refresh_requested_at = NOW(), updated_at = NOW() WHERE id = true');
            stats.stockRefreshRequested = true;
          }
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
      `, [token.tenant_id, Math.min(MAX_CONTACT_EVENTS_PER_RUN, Math.max(0, workerBudget - invoiceEvents.rows.length))]);
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
