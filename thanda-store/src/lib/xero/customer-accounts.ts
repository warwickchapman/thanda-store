import crypto from 'node:crypto';
import { assertHubSnapshot } from '@/lib/xero/hub.mjs';
import pool from '@/lib/db';
import { ensureAuthSchema } from '@/lib/auth/schema';
import type { PortalUser } from '@/lib/auth/server';
import { xeroAccountingFetch } from '@/lib/xero/oauth';

// Customer documents are a local snapshot. Invoice and credit-note changes
// arrive through webhooks; a six-hour collection refresh is only the safety
// net for quote changes and missed deliveries, not a browser-page side effect.
const CACHE_TTL_MS = 6 * 60 * 60_000;
const FORCED_REFRESH_COOLDOWN_MS = 30 * 60_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 1000;
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

export type CustomerDocumentView = 'current' | 'invoice' | 'quote' | 'credit_note';

export type CustomerDocumentsPage = {
  documents: CustomerDocument[];
  total: number;
  page: number;
  pageSize: number;
  openInvoices: number;
  creditAvailable: number;
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

async function xeroJson(pathname: string, source: string, ifModifiedSince: string | null = null) {
  const response = await xeroAccountingFetch(pathname, {
    headers: ifModifiedSince ? { 'If-Modified-Since': ifModifiedSince } : undefined,
  });
  if (response.status === 304) return {};
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Xero document request failed: ${response.status}`);
  return payload as Record<string, unknown>;
}

async function fetchPages(pathname: string, key: string, source: string, ifModifiedSince: string | null = null) {
  const records: Record<string, unknown>[] = [];
  let snapshot: string | undefined;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = pathname.includes('?') ? '&' : '?';
    const payload = await xeroJson(`${pathname}${separator}page=${page}&pageSize=${PAGE_SIZE}`, source, ifModifiedSince);
    snapshot = assertHubSnapshot(payload, snapshot);
    const pageRecords = Array.isArray(payload[key]) ? payload[key] as Record<string, unknown>[] : [];
    records.push(...pageRecords);
    if (pageRecords.length < PAGE_SIZE) return records;
  }
  throw new Error('The complete document collection could not be read; previous data is retained.');
}

async function writeDocuments(contactId: string, documents: Array<{ document: CustomerDocument; raw: Record<string, unknown> }>, replaceSnapshot: boolean) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (replaceSnapshot) await client.query('DELETE FROM xero_customer_documents WHERE contact_id = $1', [contactId]);
    for (const { document, raw } of documents) {
      await client.query(`
        INSERT INTO xero_customer_documents (
          contact_id, document_type, document_id, document_number, status, document_date, due_date,
          reference, currency_code, total, amount_paid, amount_due, payload, xero_updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
        ON CONFLICT (contact_id, document_type, document_id) DO UPDATE SET
          document_number = EXCLUDED.document_number,
          status = EXCLUDED.status,
          document_date = EXCLUDED.document_date,
          due_date = EXCLUDED.due_date,
          reference = EXCLUDED.reference,
          currency_code = EXCLUDED.currency_code,
          total = EXCLUDED.total,
          amount_paid = EXCLUDED.amount_paid,
          amount_due = EXCLUDED.amount_due,
          payload = EXCLUDED.payload,
          xero_updated_at = EXCLUDED.xero_updated_at,
          synced_at = NOW()
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
  const state = await pool.query('SELECT last_successful_sync_at FROM xero_customer_document_sync_state WHERE contact_id = $1', [contactId]);
  const lastSync = state.rows[0]?.last_successful_sync_at ? new Date(state.rows[0].last_successful_sync_at) : null;
  const cached = await pool.query('SELECT 1 FROM xero_customer_documents WHERE contact_id = $1 LIMIT 1', [contactId]);
  const replaceSnapshot = !lastSync || !cached.rowCount;
  const ifModifiedSince = replaceSnapshot ? null : lastSync!.toUTCString();
  // Initial setup imports a bounded snapshot. Every later refresh asks Xero
  // only for documents changed since the previous successful sync.
  const quotes = await fetchPages(`/Quotes?ContactID=${encodeURIComponent(contactId)}`, 'Quotes', 'customer-documents:quotes', ifModifiedSince);
  const invoices = await fetchPages(`/Invoices?ContactIDs=${encodeURIComponent(contactId)}`, 'Invoices', 'customer-documents:invoices', ifModifiedSince);
  const creditNotes = await fetchPages(`/CreditNotes?ContactIDs=${encodeURIComponent(contactId)}`, 'CreditNotes', 'customer-documents:credit-notes', ifModifiedSince);
  const documents = [
    ...quotes.map((raw) => ({ raw, document: documentFromXero('quote', raw) })),
    ...invoices.filter((raw) => String(raw.Type || '').toUpperCase() === 'ACCREC').map((raw) => ({ raw, document: documentFromXero('invoice', raw) })),
    ...creditNotes.filter((raw) => String(raw.Type || '').toUpperCase() === 'ACCRECCREDIT').map((raw) => ({ raw, document: documentFromXero('credit_note', raw) })),
  ].filter((entry) => {
    const entryContactId = String((entry.raw.Contact as { ContactID?: unknown } | undefined)?.ContactID || '');
    return entryContactId === contactId;
  }).filter((entry): entry is { raw: Record<string, unknown>; document: CustomerDocument } => Boolean(entry.document));
  await writeDocuments(contactId, documents, true);
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

export async function customerDocumentsPage(
  user: PortalUser,
  options: { refresh?: boolean; page?: number; pageSize?: number; query?: string; view?: CustomerDocumentView } = {},
): Promise<CustomerDocumentsPage> {
  await ensureAuthSchema();
  if (!user.xeroContactId) throw new Error('Your account is not linked to a Xero customer.');

  const page = Math.max(1, Math.floor(options.page || 1));
  const pageSize = Math.min(50, Math.max(10, Math.floor(options.pageSize || 25)));
  const query = String(options.query || '').trim().slice(0, 100);
  const view = options.view || 'current';
  const state = await pool.query('SELECT last_successful_sync_at FROM xero_customer_document_sync_state WHERE contact_id = $1', [user.xeroContactId]);
  const lastSync = state.rows[0]?.last_successful_sync_at ? Date.parse(state.rows[0].last_successful_sync_at) : 0;
  const shouldRefresh = !lastSync || Date.now() - lastSync > CACHE_TTL_MS;
  const forcedRefreshAllowed = options.refresh && (!lastSync || Date.now() - lastSync > FORCED_REFRESH_COOLDOWN_MS);
  if (shouldRefresh || forcedRefreshAllowed) await refreshCustomerDocuments(user);

  const conditions = ['contact_id = $1'];
  const values: unknown[] = [user.xeroContactId];
  if (view === 'current') {
    conditions.push("((document_type = 'invoice' AND amount_due > 0) OR (document_type = 'quote' AND status IN ('SENT', 'ACCEPTED'))) ");
  } else {
    values.push(view);
    conditions.push(`document_type = $${values.length}`);
  }
  if (query) {
    values.push(`%${query}%`);
    conditions.push(`(document_number ILIKE $${values.length} OR reference ILIKE $${values.length})`);
  }
  const where = conditions.join(' AND ');
  const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM xero_customer_documents WHERE ${where}`, values);
  values.push(pageSize, (page - 1) * pageSize);
  const result = await pool.query(`
    SELECT document_type, document_id, document_number, status, document_date, due_date, reference,
           currency_code, total, amount_paid, amount_due
    FROM xero_customer_documents
    WHERE ${where}
    ORDER BY document_date DESC NULLS LAST, document_number DESC
    LIMIT $${values.length - 1} OFFSET $${values.length}
  `, values);
  const summary = await pool.query(`
    SELECT
      COALESCE(SUM(amount_due) FILTER (WHERE document_type = 'invoice'), 0) AS open_invoices,
      COALESCE(SUM(amount_due) FILTER (WHERE document_type = 'credit_note'), 0) AS credit_available
    FROM xero_customer_documents WHERE contact_id = $1
  `, [user.xeroContactId]);
  return {
    documents: result.rows.map((row) => ({
      type: row.document_type, id: row.document_id, number: row.document_number, status: row.status,
      date: row.document_date ? String(row.document_date).slice(0, 10) : null,
      dueDate: row.due_date ? String(row.due_date).slice(0, 10) : null,
      reference: row.reference, currency: row.currency_code, total: numberValue(row.total),
      paid: numberValue(row.amount_paid), due: numberValue(row.amount_due),
    })) as CustomerDocument[],
    total: numberValue(countResult.rows[0]?.total), page, pageSize,
    openInvoices: numberValue(summary.rows[0]?.open_invoices),
    creditAvailable: numberValue(summary.rows[0]?.credit_available),
  };
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
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Actor': `portal-user:${user.id}`, 'X-Hub-Contact': user.xeroContactId, 'Idempotency-Key': crypto.createHash('sha256').update(JSON.stringify({ quoteId, accept, actor: user.id, revision: quote.UpdatedDateUTC })).digest('hex') },
    body: JSON.stringify({
      Contact: { ContactID: user.xeroContactId },
      Date: dateValue(quote.DateString || quote.Date),
      Status: accept ? 'ACCEPTED' : 'SENT',
    }),
  });
  if (!response.ok) throw new Error('Xero could not update this quote.');
  await refreshCustomerDocuments(user);
  await auditAccountAction(user, accept ? 'quote_accepted' : 'quote_unaccepted', 'quote', quoteId, { quoteNumber: quote.QuoteNumber || null });
}

export async function customerDocumentPdf(user: PortalUser, type: CustomerDocument['type'], id: string) {
  const cached = await customerDocument(user, type, id);
  if (!cached) throw new Error('Document not found for your company.');
  const path = type === 'quote' ? `/Quotes/${id}/pdf` : type === 'invoice' ? `/Invoices/${id}/pdf` : `/CreditNotes/${id}/pdf`;
  const response = await xeroAccountingFetch(path, { headers: { Accept: 'application/pdf', 'X-Hub-Actor': `portal-user:${user.id}`, 'X-Hub-Contact': user.xeroContactId || '' } });
  if (!response.ok) {
    console.error('Xero customer document PDF request failed', {
      type,
      documentId: id,
      status: response.status,
      xeroCorrelationId: response.headers.get('xero-correlation-id'),
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error('Xero denied access to this PDF. An administrator must reconnect Xero.');
    }
    if (response.status === 404) throw new Error('Xero no longer has a PDF for this document. Refresh Accounts and try again.');
    throw new Error('Xero could not retrieve this PDF.');
  }
  await auditAccountAction(user, 'document_viewed', type, id, { documentNumber: cached.document_number });
  return { response, number: String(cached.document_number || id) };
}
