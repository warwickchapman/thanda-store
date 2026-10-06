import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshAccountDocuments } from '../src/lib/xero/customer-document-projection.mjs';

const CONTACT = 'customer-1';
const OBSERVED = '2026-10-06T08:00:00.000Z';

function database({ locked = true, requestedAt = null, failInsert = false } = {}) {
  const queries = [];
  let released = false;
  const client = {
    async query(input, values = []) {
      const text = typeof input === 'string' ? input : input.text;
      const parameters = typeof input === 'string' ? values : input.values;
      queries.push({ text, values: parameters, timeout: input.query_timeout });
      if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
      if (text.startsWith('SELECT refresh_requested_at')) return { rows: [{ refresh_requested_at: requestedAt }] };
      if (failInsert && text.includes('jsonb_to_recordset')) throw new Error('Database publish failed');
      return { rows: [], rowCount: 1 };
    },
    release() { released = true; },
  };
  return { pool: { async connect() { return client; } }, queries, get released() { return released; } };
}

function payload(key, records = [], metadata = {}) {
  return { [key]: records, _hub: { complete: true, snapshot: `${key}-snapshot`, observed_at: OBSERVED, ...metadata } };
}

function hub(pages = {}) {
  const requests = [];
  return {
    requests,
    async fetch(path, options) {
      requests.push({ path, options });
      const url = new URL(path, 'https://hub.invalid');
      const key = url.pathname.slice(1);
      const page = Number(url.searchParams.get('page'));
      const body = pages[key]?.[page - 1] || payload(key);
      return { ok: true, status: 200, async json() { return body; } };
    },
  };
}

function quote(id) {
  return { QuoteID: id, QuoteNumber: `QU-${id}`, Contact: { ContactID: CONTACT }, Status: 'SENT', DateString: '2026-10-06', Total: 123.45 };
}

test('publishes only complete pinned snapshots in batches and preserves local quote rows', async () => {
  const db = database({ requestedAt: '2026-10-06T09:00:00.000Z' });
  const firstPage = Array.from({ length: 100 }, (_, i) => quote(String(i)));
  const creditObserved = '2026-10-05T22:00:00.000Z';
  const request = hub({
    Quotes: [payload('Quotes', firstPage), payload('Quotes', [quote('100')])],
    Invoices: [payload('Invoices', [
      { InvoiceID: 'invoice-1', Type: 'ACCREC', Contact: { ContactID: CONTACT }, AmountDue: 25 },
      { InvoiceID: 'payable-1', Type: 'ACCPAY', Contact: { ContactID: CONTACT } },
      { InvoiceID: 'other-customer', Type: 'ACCREC', Contact: { ContactID: 'customer-2' } },
    ])],
    CreditNotes: [payload('CreditNotes', [{ CreditNoteID: 'credit-1', Type: 'ACCRECCREDIT', Contact: { ContactID: CONTACT }, AmountDue: 10 }], { observed_at: creditObserved })],
  });
  const result = await refreshAccountDocuments(db.pool, request.fetch, CONTACT);
  assert.deepEqual(result, { refreshed: true, count: 103, sourceObservedAt: creditObserved });
  assert.equal(request.requests.length, 4);
  assert.equal(request.requests[0].options.headers['X-Hub-Snapshot'], undefined);
  assert.equal(request.requests[1].options.headers['X-Hub-Snapshot'], 'Quotes-snapshot');
  assert.equal(request.requests[1].path, '/Quotes?ContactID=customer-1&page=2&pageSize=100');
  assert.equal(request.requests[2].options.headers['X-Hub-Snapshot'], undefined);
  assert.ok(request.requests.every(({ options }) => options.signal instanceof AbortSignal));
  const deletion = db.queries.find(query => query.text.startsWith('DELETE'));
  assert.match(deletion.text, /NOT EXISTS \(SELECT 1 FROM portal_quote_requests/);
  assert.match(deletion.text, /r\.contact_id=d\.contact_id AND r\.quote_id=d\.document_id AND d\.document_type='quote'/);
  const batches = db.queries.filter(query => query.text.includes('jsonb_to_recordset'));
  assert.equal(batches.length, 1);
  const rows = JSON.parse(batches[0].values[1]);
  assert.equal(rows.length, 103);
  assert.equal(rows.find(row => row.document_id === 'credit-1').synced_at, creditObserved);
  assert.equal(rows.find(row => row.document_id === 'invoice-1').amount_due, 25);
  assert.match(batches[0].text, /WHERE EXCLUDED\.synced_at >= xero_customer_documents\.synced_at/);
  const success = db.queries.find(query => query.text.includes('last_successful_sync_at=NOW()'));
  assert.deepEqual(success.values, [CONTACT, creditObserved, '2026-10-06T09:00:00.000Z']);
  assert.match(success.text, /refresh_requested_at IS NOT DISTINCT FROM \$3::timestamptz/);
  assert.equal(db.queries.at(-2).text, 'COMMIT');
  assert.match(db.queries.at(-1).text, /pg_advisory_unlock/);
  assert.equal(db.released, true);
});

test('a multi-thousand document import uses bounded batch writes', async () => {
  const db = database();
  const invoices = Array.from({ length: 6005 }, (_, i) => ({ InvoiceID: `invoice-${i}`, Type: 'ACCREC', Contact: { ContactID: CONTACT } }));
  const pages = [];
  for (let i = 0; i < invoices.length; i += 100) pages.push(payload('Invoices', invoices.slice(i, i + 100)));
  const request = hub({ Invoices: pages });
  const result = await refreshAccountDocuments(db.pool, request.fetch, CONTACT);
  assert.equal(result.count, 6005);
  const batches = db.queries.filter(query => query.text.includes('jsonb_to_recordset'));
  assert.equal(batches.length, 7);
  assert.ok(batches.every(query => JSON.parse(query.values[1]).length <= 1000));
  assert.ok(db.queries.length < 20);
});

for (const [name, secondPage] of [
  ['incomplete evidence', payload('Quotes', [], { complete: false })],
  ['changing snapshot', payload('Quotes', [], { snapshot: 'new-snapshot' })],
  ['changing source observation', payload('Quotes', [], { observed_at: '2026-10-06T09:00:00.000Z' })],
  ['missing collection', { _hub: { complete: true, snapshot: 'Quotes-snapshot', observed_at: OBSERVED } }],
]) {
  test(`${name} retains the old documents and leaves the refresh queued`, async () => {
    const db = database();
    const request = hub({ Quotes: [payload('Quotes', Array.from({ length: 100 }, (_, i) => quote(String(i)))), secondPage] });
    await assert.rejects(refreshAccountDocuments(db.pool, request.fetch, CONTACT));
    assert.equal(db.queries.some(query => query.text === 'BEGIN'), false);
    assert.equal(db.queries.some(query => query.text.startsWith('DELETE')), false);
    assert.equal(db.queries.some(query => query.text.includes('jsonb_to_recordset')), false);
    const error = db.queries.find(query => query.text.includes('SET last_error=$2'));
    assert.ok(error);
    assert.match(error.text, /updated_at=NOW\(\)/);
    assert.doesNotMatch(error.text, /refresh_requested_at/);
    assert.equal(db.released, true);
  });
}

test('only one worker can refresh the same customer at a time', async () => {
  const db = database({ locked: false });
  const request = hub();
  assert.deepEqual(await refreshAccountDocuments(db.pool, request.fetch, CONTACT), { refreshed: false, reason: 'locked' });
  assert.equal(request.requests.length, 0);
  assert.equal(db.queries.length, 1);
  assert.equal(db.released, true);
});

test('a failed publish rolls back all replacement writes and retains the queued request', async () => {
  const db = database({ failInsert: true });
  const request = hub({ Quotes: [payload('Quotes', [quote('1')])] });
  await assert.rejects(refreshAccountDocuments(db.pool, request.fetch, CONTACT), /Database publish failed/);
  assert.equal(db.queries.some(query => query.text === 'ROLLBACK'), true);
  assert.equal(db.queries.some(query => query.text === 'COMMIT'), false);
  assert.equal(db.queries.some(query => query.text.includes('last_successful_sync_at=NOW()')), false);
  assert.equal(db.released, true);
});

test('each response has a timeout even when the fetch implementation ignores its abort signal', async () => {
  const db = database();
  let signal;
  const neverResponds = async (_path, options) => { signal = options.signal; return new Promise(() => {}); };
  await assert.rejects(refreshAccountDocuments(db.pool, neverResponds, CONTACT, { responseTimeoutMs: 10 }), /request timed out/);
  assert.equal(signal.aborted, true);
  assert.equal(db.queries.some(query => query.text.startsWith('DELETE')), false);
  assert.equal(db.released, true);
});

test('a slow import stops at the overall deadline before publishing', async () => {
  const db = database();
  const request = hub();
  let clock = 0;
  const slowFetch = async (...args) => { const response = await request.fetch(...args); clock = 301_000; return response; };
  await assert.rejects(refreshAccountDocuments(db.pool, slowFetch, CONTACT, { now: () => clock }), /import timed out/);
  assert.equal(request.requests.length, 1);
  assert.equal(db.queries.some(query => query.text.startsWith('DELETE')), false);
});

test('a full page at the bounded page limit never becomes a truncated published snapshot', async () => {
  const db = database();
  const request = hub({ Quotes: [payload('Quotes', Array.from({ length: 100 }, (_, i) => quote(String(i))))] });
  await assert.rejects(refreshAccountDocuments(db.pool, request.fetch, CONTACT, { maxPages: 1 }), /exceeds the import limit/);
  assert.equal(db.queries.some(query => query.text.startsWith('DELETE')), false);
});
