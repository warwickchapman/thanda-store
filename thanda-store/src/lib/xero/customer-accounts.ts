import pool from '@/lib/db';
import { ensureAuthSchema } from '@/lib/auth/schema';
import type { PortalUser } from '@/lib/auth/server';
import { xeroAccountingFetch } from '@/lib/xero/oauth';

const CACHE_TTL_MS = 15 * 60_000;
const FORCED_REFRESH_COOLDOWN_MS = 60_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MIN_XERO_REQUEST_GAP_MS = 1_100;
const MIN_DAY_ALLOWANCE = 100;

let lastXeroRequestAt = 0;

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export type CustomerDocument = {
  type: 'quote' | 'invoice' | 'credit_note';
  id: string;
  number: string;
  status: string;
  date: string | null;
  dueDate: string | null;
  reference: string;
  currency: string;
  total: number;
  paid: number;
  due: number;
};

function dateValue(value: unknown) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function documentFromXero(type: CustomerDocument['type'], raw: Record<string, unknown>): CustomerDocument | null {
  const id = String(raw.QuoteID || raw.InvoiceID || raw.CreditNoteID || '');
  const contactId = String((raw.Contact as { ContactID?: unknown } | undefined)?.ContactID || '');
  if (!id || !contactId) return null;
  return {
    type,
    id,
    number: String(raw.QuoteNumber || raw.InvoiceNumber || raw.CreditNoteNumber || ''),
    status: String(raw.Status || ''),
    date: dateValue(raw.DateString || raw.Date),
    dueDate: dateValue(raw.DueDateString || raw.DueDate),
    reference: String(raw.Reference || ''),
    currency: String(raw.CurrencyCode || 'ZAR'),
    total: numberValue(raw.Total),
    paid: numberValue(raw.AmountPaid),
    due: numberValue(raw.AmountDue),
  };
}

async function recordUsage(response: Response, source: string) {
  const value = (name: string) => {
    const parsed = Number(response.headers.get(name));
    return Number.isFinite(parsed) ? parsed : null;
  };
  await pool.query(`
    INSERT INTO xero_api_usage (id, day_limit_remaining, minute_limit_remaining, app_minute_limit_remaining, rate_limit_problem, retry_after_seconds, next_allowed_at, source, observed_at)
    VALUES (true, $1, $2, $3, $4, $5, $6, $7, NOW())
    ON CONFLICT (id) DO UPDATE SET
      day_limit_remaining = EXCLUDED.day_limit_remaining,
      minute_limit_remaining = EXCLUDED.minute_limit_remaining,
      app_minute_limit_remaining = EXCLUDED.app_minute_limit_remaining,
      rate_limit_problem = EXCLUDED.rate_limit_problem,
      retry_after_seconds = EXCLUDED.retry_after_seconds,
      next_allowed_at = EXCLUDED.next_allowed_at,
      source = EXCLUDED.source,
      observed_at = NOW()
  `, [
    value('x-daylimit-remaining'), value('x-minlimit-remaining'), value('x-appminlimit-remaining'),
    response.headers.get('x-rate-limit-problem'), value('retry-after'),
    response.headers.get('x-rate-limit-problem') === 'day' && value('retry-after')
      ? new Date(Date.now() + Number(value('retry-after')) * 1000).toISOString() : null,
    source,
  ]);
}

async function xeroJson(pathname: string, source: string) {
  const usage = await pool.query('SELECT day_limit_remaining, next_allowed_at FROM xero_api_usage WHERE id = true');
  const currentUsage = usage.rows[0];
  if (currentUsage?.next_allowed_at && new Date(currentUsage.next_allowed_at).getTime() > Date.now()) {
    throw new Error('Xero is temporarily rate limited. Please try again shortly.');
  }
  if (typeof currentUsage?.day_limit_remaining === 'number' && currentUsage.day_limit_remaining <= MIN_DAY_ALLOWANCE) {
    throw new Error('Xero API allowance is being reserved for operational updates. Please try again later.');
  }
  const waitFor = Math.max(0, lastXeroRequestAt + MIN_XERO_REQUEST_GAP_MS - Date.now());
  if (waitFor) await wait(waitFor);
  const response = await xeroAccountingFetch(pathname);
  lastXeroRequestAt = Date.now();
  await recordUsage(response, source);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Xero document request failed: ${response.status}`);
  return payload as Record<string, unknown>;
}

async function fetchPages(pathname: string, key: string, source: string) {
  const records: Record<string, unknown>[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = pathname.includes('?') ? '&' : '?';
    const payload = await xeroJson(`${pathname}${separator}page=${page}&pageSize=${PAGE_SIZE}`, source);
    const pageRecords = Array.isArray(payload[key]) ? payload[key] as Record<string, unknown>[] : [];
    records.push(...pageRecords);
    if (pageRecords.length < PAGE_SIZE) break;
  }
  return records;
}

async function writeDocuments(contactId: string, documents: Array<{ document: CustomerDocument; raw: Record<string, unknown> }>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM xero_customer_documents WHERE contact_id = $1', [contactId]);
    for (const { document, raw } of documents) {
      await client.query(`
        INSERT INTO xero_customer_documents (
          contact_id, document_type, document_id, document_number, status, document_date, due_date,
          reference, currency_code, total, amount_paid, amount_due, payload, xero_updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
      `, [contactId, document.type, document.id, document.number, document.status, document.date, document.dueDate,
        document.reference, document.currency, document.total, document.paid, document.due,
        JSON.stringify(raw), null]);
    }
    await client.query(`
      INSERT INTO xero_customer_document_sync_state (contact_id, last_successful_sync_at, last_error)
      VALUES ($1, NOW(), NULL)
      ON CONFLICT (contact_id) DO UPDATE SET last_successful_sync_at = NOW(), last_error = NULL, updated_at = NOW()
    `, [contactId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function auditAccountAction(user: PortalUser, action: string, resourceType?: string, resourceId?: string, metadata: Record<string, unknown> = {}) {
  await ensureAuthSchema();
  await pool.query(`
    INSERT INTO portal_activity_log (user_id, organisation_id, action, resource_type, resource_id, metadata)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
  `, [user.id, user.organisationId, action, resourceType || null, resourceId || null, JSON.stringify(metadata)]);
}

export async function refreshCustomerDocuments(user: PortalUser) {
  if (!user.xeroContactId) throw new Error('Your account is not linked to a Xero customer.');
  const contactId = user.xeroContactId;
  // Customer pages are deliberately sequential and throttled. Xero's customer
  // documents endpoints are cached below, so browsing does not create a burst.
  const quotes = await fetchPages(`/Quotes?ContactID=${encodeURIComponent(contactId)}`, 'Quotes', 'customer-accounts');
  const invoices = await fetchPages(`/Invoices?ContactIDs=${encodeURIComponent(contactId)}`, 'Invoices', 'customer-accounts');
  const creditNotes = await fetchPages(`/CreditNotes?ContactIDs=${encodeURIComponent(contactId)}`, 'CreditNotes', 'customer-accounts');
  const documents = [
    ...quotes.map((raw) => ({ raw, document: documentFromXero('quote', raw) })),
    ...invoices.filter((raw) => String(raw.Type || '').toUpperCase() === 'ACCREC').map((raw) => ({ raw, document: documentFromXero('invoice', raw) })),
    ...creditNotes.filter((raw) => String(raw.Type || '').toUpperCase() === 'ACCRECCREDIT').map((raw) => ({ raw, document: documentFromXero('credit_note', raw) })),
  ].filter((entry) => {
    const entryContactId = String((entry.raw.Contact as { ContactID?: unknown } | undefined)?.ContactID || '');
    return entryContactId === contactId;
  }).filter((entry): entry is { raw: Record<string, unknown>; document: CustomerDocument } => Boolean(entry.document));
  await writeDocuments(contactId, documents);
  return documents.length;
}

export async function customerDocuments(user: PortalUser, refresh = false) {
  await ensureAuthSchema();
  if (!user.xeroContactId) throw new Error('Your account is not linked to a Xero customer.');
  const state = await pool.query('SELECT last_successful_sync_at FROM xero_customer_document_sync_state WHERE contact_id = $1', [user.xeroContactId]);
  const lastSync = state.rows[0]?.last_successful_sync_at ? Date.parse(state.rows[0].last_successful_sync_at) : 0;
  const shouldRefresh = !lastSync || Date.now() - lastSync > CACHE_TTL_MS;
  const forcedRefreshAllowed = refresh && (!lastSync || Date.now() - lastSync > FORCED_REFRESH_COOLDOWN_MS);
  if (shouldRefresh || forcedRefreshAllowed) await refreshCustomerDocuments(user);
  const result = await pool.query(`
    SELECT document_type, document_id, document_number, status, document_date, due_date, reference,
           currency_code, total, amount_paid, amount_due
    FROM xero_customer_documents
    WHERE contact_id = $1
    ORDER BY document_date DESC NULLS LAST, document_number DESC
  `, [user.xeroContactId]);
  return result.rows.map((row) => ({
    type: row.document_type, id: row.document_id, number: row.document_number, status: row.status,
    date: row.document_date ? String(row.document_date).slice(0, 10) : null,
    dueDate: row.due_date ? String(row.due_date).slice(0, 10) : null,
    reference: row.reference, currency: row.currency_code, total: numberValue(row.total),
    paid: numberValue(row.amount_paid), due: numberValue(row.amount_due),
  })) as CustomerDocument[];
}

export async function customerDocument(user: PortalUser, type: CustomerDocument['type'], id: string) {
  const result = await pool.query(`
    SELECT payload, document_number, status, document_date, due_date, reference, currency_code, total, amount_paid, amount_due
    FROM xero_customer_documents WHERE contact_id = $1 AND document_type = $2 AND document_id = $3
  `, [user.xeroContactId, type, id]);
  return result.rows[0] || null;
}

export async function updateQuoteAcceptance(user: PortalUser, quoteId: string, accept: boolean) {
  if (!user.xeroContactId) throw new Error('Your account is not linked to a Xero customer.');
  const payload = await xeroJson(`/Quotes/${encodeURIComponent(quoteId)}`, 'customer-quote-action');
  const quote = Array.isArray(payload.Quotes) ? payload.Quotes[0] as Record<string, unknown> : null;
  const contactId = String((quote?.Contact as { ContactID?: unknown } | undefined)?.ContactID || '');
  const status = String(quote?.Status || '').toUpperCase();
  if (!quote || contactId !== user.xeroContactId) throw new Error('Quote not found for your company.');
  if (accept && status !== 'SENT') throw new Error('Only sent quotes can be accepted.');
  if (!accept && status !== 'ACCEPTED') throw new Error('Only accepted quotes can be marked unaccepted.');
  const response = await xeroAccountingFetch(`/Quotes/${encodeURIComponent(quoteId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Contact: { ContactID: user.xeroContactId },
      Date: dateValue(quote.DateString || quote.Date),
      Status: accept ? 'ACCEPTED' : 'SENT',
    }),
  });
  await recordUsage(response, 'customer-quote-action');
  if (!response.ok) throw new Error('Xero could not update this quote.');
  await refreshCustomerDocuments(user);
  await auditAccountAction(user, accept ? 'quote_accepted' : 'quote_unaccepted', 'quote', quoteId, { quoteNumber: quote.QuoteNumber || null });
}

export async function customerDocumentPdf(user: PortalUser, type: CustomerDocument['type'], id: string) {
  const cached = await customerDocument(user, type, id);
  if (!cached) throw new Error('Document not found for your company.');
  const path = type === 'quote' ? `/Quotes/${id}/pdf` : type === 'invoice' ? `/Invoices/${id}/pdf` : `/CreditNotes/${id}/pdf`;
  const response = await xeroAccountingFetch(path, { headers: { Accept: 'application/pdf' } });
  await recordUsage(response, 'customer-document-pdf');
  if (!response.ok) throw new Error('Xero could not retrieve this PDF.');
  await auditAccountAction(user, 'document_viewed', type, id, { documentNumber: cached.document_number });
  return { response, number: String(cached.document_number || id) };
}
