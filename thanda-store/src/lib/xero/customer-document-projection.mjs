import { assertHubSnapshot } from './hub.mjs';

const PAGE_SIZE = 100;
const MAX_PAGES = 1000;
const MAX_DURATION_MS = 5 * 60_000;
const RESPONSE_TIMEOUT_MS = 20_000;
const BATCH_SIZE = 1000;

function timestamp(value) {
  const text = String(value || '');
  const wrapped = text.match(/^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/);
  const parsed = wrapped ? Number(wrapped[1]) : Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function date(value) {
  const text = String(value || '');
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return timestamp(value)?.slice(0, 10) || null;
}

function amount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mappedDocument(type, raw, contactId, observedAt) {
  if (String(raw?.Contact?.ContactID || '') !== contactId) return null;
  if (type === 'invoice' && raw.Type !== 'ACCREC') return null;
  if (type === 'credit_note' && raw.Type !== 'ACCRECCREDIT') return null;
  const id = String(raw.QuoteID || raw.InvoiceID || raw.CreditNoteID || '');
  if (!id) throw new Error('Saved account document has no identity; previous data is retained.');
  return {
    document_type: type, document_id: id,
    document_number: String(raw.QuoteNumber || raw.InvoiceNumber || raw.CreditNoteNumber || ''),
    status: String(raw.Status || ''), document_date: date(raw.DateString || raw.Date),
    due_date: date(raw.DueDateString || raw.DueDate), reference: String(raw.Reference || ''),
    currency_code: String(raw.CurrencyCode || 'ZAR'), total: amount(raw.Total),
    amount_paid: amount(raw.AmountPaid), amount_due: amount(raw.AmountDue),
    payload: raw, xero_updated_at: timestamp(raw.UpdatedDateUTC), synced_at: observedAt,
  };
}

// hubFetch only reads stored Hub accounting collections. No request made here
// calls Xero, and every paginated collection is pinned to its first revision.
export async function refreshAccountDocuments(pool, hubFetch, contactId, options = {}) {
  if (!contactId) throw new Error('A Xero customer identity is required.');
  const now = options.now || Date.now;
  const deadline = now() + Math.min(options.maxDurationMs ?? MAX_DURATION_MS, MAX_DURATION_MS);
  const maxPages = Math.min(options.maxPages ?? MAX_PAGES, MAX_PAGES);
  const responseTimeoutMs = Math.min(options.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS, RESPONSE_TIMEOUT_MS);
  const remaining = () => {
    const duration = deadline - now();
    if (duration <= 0) throw new Error('Saved account document import timed out; previous data is retained.');
    return duration;
  };
  const client = await pool.connect();
  const lock = `customer-documents:${contactId}`;
  let locked = false;
  let transaction = false;
  // A per-query timeout also bounds database waits; the transaction receives a
  // server-side statement deadline before publishing the replacement snapshot.
  const query = (text, values = []) => client.query({ text, values, query_timeout: remaining() });
  try {
    locked = Boolean((await query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [lock])).rows[0]?.locked);
    if (!locked) return { refreshed: false, reason: 'locked' };
    await query(`INSERT INTO xero_customer_document_sync_state (contact_id)
      VALUES ($1) ON CONFLICT (contact_id) DO NOTHING`, [contactId]);
    // Keep PostgreSQL microseconds for the compare-and-clear below; pg's Date
    // conversion truncates them and would leave a successful import queued.
    const state = await query('SELECT refresh_requested_at::text AS refresh_requested_at FROM xero_customer_document_sync_state WHERE contact_id=$1', [contactId]);
    const requestedAt = state.rows[0]?.refresh_requested_at || null;

    async function collection(path, key, type) {
      const documents = [];
      let snapshot;
      let observedAt;
      for (let page = 1; page <= maxPages; page++) {
        const duration = Math.min(responseTimeoutMs, remaining());
        const abort = new AbortController();
        let timer;
        try {
          const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
              abort.abort();
              reject(new Error('Saved account document request timed out; previous data is retained.'));
            }, duration);
          });
          const payload = await Promise.race([
            (async () => {
              const response = await hubFetch(`${path}&page=${page}&pageSize=${PAGE_SIZE}`, {
                signal: abort.signal,
                headers: snapshot ? { 'X-Hub-Snapshot': snapshot } : {},
              });
              if (!response.ok) throw new Error(`Saved account documents unavailable (${response.status}); previous data is retained.`);
              try { return await response.json(); }
              catch { throw new Error('Saved account document response was invalid; previous data is retained.'); }
            })(),
            timeout,
          ]);
          snapshot = assertHubSnapshot(payload, snapshot);
          const pageObservedAt = timestamp(payload._hub.observed_at);
          if (!pageObservedAt || (observedAt && observedAt !== pageObservedAt) || !Array.isArray(payload[key])) {
            throw new Error('Saved account document evidence is incomplete; previous data is retained.');
          }
          observedAt = pageObservedAt;
          for (const raw of payload[key]) {
            const document = mappedDocument(type, raw, contactId, observedAt);
            if (document) documents.push(document);
          }
          if (payload[key].length < PAGE_SIZE) return { documents, observedAt };
        } finally { clearTimeout(timer); }
      }
      throw new Error('Saved account document collection exceeds the import limit; previous data is retained.');
    }

    const contact = encodeURIComponent(contactId);
    const streams = [
      await collection(`/Quotes?ContactID=${contact}`, 'Quotes', 'quote'),
      await collection(`/Invoices?ContactIDs=${contact}`, 'Invoices', 'invoice'),
      await collection(`/CreditNotes?ContactIDs=${contact}`, 'CreditNotes', 'credit_note'),
    ];
    // Source observation and successful local import are different timestamps.
    const sourceObservedAt = streams.map(stream => stream.observedAt).sort()[0];
    const documents = streams.flatMap(stream => stream.documents);
    remaining();
    await query('BEGIN');
    transaction = true;
    await query("SELECT set_config('statement_timeout', $1, true)", [String(Math.max(1, Math.floor(remaining())))]);
    await query(`DELETE FROM xero_customer_documents d WHERE contact_id=$1
      AND d.synced_at <= CASE d.document_type
        WHEN 'quote' THEN $2::timestamptz WHEN 'invoice' THEN $3::timestamptz
        WHEN 'credit_note' THEN $4::timestamptz END
      AND NOT EXISTS (SELECT 1 FROM portal_quote_requests r
        WHERE r.contact_id=d.contact_id AND r.quote_id=d.document_id AND d.document_type='quote')`,
    [contactId, ...streams.map(stream => stream.observedAt)]);
    for (let offset = 0; offset < documents.length; offset += BATCH_SIZE) {
      await query(`INSERT INTO xero_customer_documents (
        contact_id, document_type, document_id, document_number, status, document_date, due_date,
        reference, currency_code, total, amount_paid, amount_due, payload, xero_updated_at, synced_at
      ) SELECT $1, d.* FROM jsonb_to_recordset($2::jsonb) AS d(
        document_type text, document_id text, document_number text, status text, document_date date, due_date date,
        reference text, currency_code text, total numeric, amount_paid numeric, amount_due numeric,
        payload jsonb, xero_updated_at timestamptz, synced_at timestamptz
      ) ON CONFLICT (contact_id, document_type, document_id) DO UPDATE SET
        document_number=EXCLUDED.document_number, status=EXCLUDED.status,
        document_date=EXCLUDED.document_date, due_date=EXCLUDED.due_date,
        reference=EXCLUDED.reference, currency_code=EXCLUDED.currency_code,
        total=EXCLUDED.total, amount_paid=EXCLUDED.amount_paid, amount_due=EXCLUDED.amount_due,
        payload=EXCLUDED.payload, xero_updated_at=EXCLUDED.xero_updated_at, synced_at=EXCLUDED.synced_at
      WHERE EXCLUDED.synced_at >= xero_customer_documents.synced_at`, [contactId, JSON.stringify(documents.slice(offset, offset + BATCH_SIZE))]);
    }
    await query(`UPDATE xero_customer_document_sync_state SET
      last_successful_sync_at=NOW(), source_observed_at=$2, last_error=NULL,
      refresh_requested_at=CASE WHEN refresh_requested_at IS NOT DISTINCT FROM $3::timestamptz
        THEN NULL ELSE refresh_requested_at END, updated_at=NOW()
      WHERE contact_id=$1`, [contactId, sourceObservedAt, requestedAt]);
    await query('COMMIT');
    transaction = false;
    return { refreshed: true, count: documents.length, sourceObservedAt };
  } catch (error) {
    if (transaction) await client.query('ROLLBACK');
    if (locked) await client.query(`UPDATE xero_customer_document_sync_state
      SET last_error=$2, updated_at=NOW() WHERE contact_id=$1`, [contactId, String(error?.message || 'Account document import failed').slice(0, 500)]);
    throw error;
  } finally {
    try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lock]); }
    finally { client.release(); }
  }
}
