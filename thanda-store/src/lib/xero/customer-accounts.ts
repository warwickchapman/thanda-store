import crypto from 'node:crypto';
import { cacheCreatedQuote } from '@/lib/commerce/quote-requests.mjs';
import pool from '@/lib/db';
import { ensureAuthSchema } from '@/lib/auth/schema';
import type { PortalUser } from '@/lib/auth/server';
import { xeroAccountingFetch } from '@/lib/xero/oauth';

// Accounts reads only its local snapshot. The existing webhook worker imports
// complete stored Hub history in the background, with zero Xero calls here.
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
  sync: { pending: boolean; observedAt: string | null; lastError: string | null; hasSnapshot: boolean };
};

function dateValue(value: unknown) {
  const text = value instanceof Date ? value.toISOString() : String(value || '');
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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

export async function auditAccountAction(user: PortalUser, action: string, resourceType?: string, resourceId?: string, metadata: Record<string, unknown> = {}) {
  await ensureAuthSchema();
  await pool.query(`
    INSERT INTO portal_activity_log (user_id, organisation_id, action, resource_type, resource_id, metadata)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
  `, [user.id, user.organisationId, action, resourceType || null, resourceId || null, JSON.stringify(metadata)]);
}

async function accountSyncState(contactId: string, refresh = false) {
  // Coalesce locally; a browser never waits for the full history import. A
  // deliberate refresh can queue at most once per 30 minutes after success.
  await pool.query(`INSERT INTO xero_customer_document_sync_state(contact_id,refresh_requested_at)
    VALUES($1,now()) ON CONFLICT(contact_id) DO UPDATE SET
      refresh_requested_at=COALESCE(xero_customer_document_sync_state.refresh_requested_at,now())
    WHERE xero_customer_document_sync_state.last_successful_sync_at IS NULL
      OR xero_customer_document_sync_state.last_successful_sync_at < now()-interval '6 hours'
      OR ($2 AND xero_customer_document_sync_state.last_successful_sync_at < now()-interval '30 minutes')`,
  [contactId, refresh]);
  const {rows} = await pool.query(`SELECT last_successful_sync_at,source_observed_at,refresh_requested_at,last_error
    FROM xero_customer_document_sync_state WHERE contact_id=$1`, [contactId]);
  const state = rows[0];
  return {
    pending: Boolean(state?.refresh_requested_at),
    observedAt: state?.source_observed_at ? new Date(state.source_observed_at).toISOString() : null,
    lastError: state?.last_error ? 'Account history could not be refreshed.' : null,
    hasSnapshot: Boolean(state?.last_successful_sync_at),
  };
}

export async function customerDocuments(user: PortalUser, refresh = false) {
  await ensureAuthSchema();
  if (!user.xeroContactId) throw new Error('Your account is not linked to a Xero customer.');
  const sync = await accountSyncState(user.xeroContactId, refresh);
  if (!sync.hasSnapshot) throw new Error('Account history is being prepared. Open Accounts and check again shortly.');
  const result = await pool.query(`
    SELECT document_type, document_id, document_number, status,
           document_date::text AS document_date, due_date::text AS due_date, reference,
           currency_code, total, amount_paid, amount_due
    FROM xero_customer_documents
    WHERE contact_id = $1 AND (document_type <> 'quote' OR status <> 'DRAFT' OR EXISTS
      (SELECT 1 FROM portal_quote_requests r WHERE r.contact_id=xero_customer_documents.contact_id AND r.quote_id=document_id))
    ORDER BY document_date DESC NULLS LAST, document_number DESC
  `, [user.xeroContactId]);
  return result.rows.map((row) => ({
    type: row.document_type, id: row.document_id, number: row.document_number, status: row.status,
    date: dateValue(row.document_date),
    dueDate: dateValue(row.due_date),
    reference: row.reference, currency: row.currency_code, total: numberValue(row.total),
    paid: numberValue(row.amount_paid), due: numberValue(row.amount_due),
  })) as CustomerDocument[];
}

export async function customerDocumentsPage(
  user: PortalUser,
  options: { refresh?: boolean; page?: number; pageSize?: number; query?: string; view?: CustomerDocumentView; quoteId?: string } = {},
): Promise<CustomerDocumentsPage> {
  await ensureAuthSchema();
  if (!user.xeroContactId) throw new Error('Your account is not linked to a Xero customer.');

  const page = Math.max(1, Math.floor(options.page || 1));
  const pageSize = Math.min(50, Math.max(10, Math.floor(options.pageSize || 25)));
  const query = String(options.query || '').trim().slice(0, 100);
  const view = options.view || 'current';
  const sync = await accountSyncState(user.xeroContactId, options.refresh);

  const conditions = ['contact_id = $1', `(document_type <> 'quote' OR status <> 'DRAFT' OR EXISTS
    (SELECT 1 FROM portal_quote_requests r WHERE r.contact_id=xero_customer_documents.contact_id AND r.quote_id=document_id))`];
  const values: unknown[] = [user.xeroContactId];
  if (options.quoteId) {
    values.push(options.quoteId); conditions.push(`document_type='quote' AND document_id=$${values.length}`);
  } else if (view === 'current') {
    conditions.push("((document_type = 'invoice' AND amount_due > 0) OR (document_type = 'quote' AND status IN ('DRAFT', 'SENT', 'ACCEPTED'))) ");
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
    SELECT document_type, document_id, document_number, status,
           document_date::text AS document_date, due_date::text AS due_date, reference,
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
      date: dateValue(row.document_date),
      dueDate: dateValue(row.due_date),
      reference: row.reference, currency: row.currency_code, total: numberValue(row.total),
      paid: numberValue(row.amount_paid), due: numberValue(row.amount_due),
    })) as CustomerDocument[],
    total: numberValue(countResult.rows[0]?.total), page, pageSize,
    openInvoices: numberValue(summary.rows[0]?.open_invoices),
    creditAvailable: numberValue(summary.rows[0]?.credit_available),
    sync,
  };
}

export async function customerDocument(user: PortalUser, type: CustomerDocument['type'], id: string) {
  const result = await pool.query(`
    SELECT payload, document_number, status, document_date, due_date, reference, currency_code, total, amount_paid, amount_due
    FROM xero_customer_documents WHERE contact_id = $1 AND document_type = $2 AND document_id = $3
      AND (document_type <> 'quote' OR status <> 'DRAFT' OR EXISTS
      (SELECT 1 FROM portal_quote_requests r WHERE r.contact_id=xero_customer_documents.contact_id AND r.quote_id=document_id))
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
  const updated = (await response.json()).Quotes?.[0];
  if (!updated?.QuoteID || updated.QuoteID !== quoteId || updated.Contact?.ContactID !== user.xeroContactId
    || updated.Status !== (accept ? 'ACCEPTED' : 'SENT')) {
    throw new Error('The quote update could not be confirmed. Refresh Accounts before retrying.');
  }
  await cacheCreatedQuote(pool, user.xeroContactId, updated);
  await accountSyncState(user.xeroContactId, true);
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
