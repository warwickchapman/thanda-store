import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { refreshAccountDocuments } from '../src/lib/xero/customer-document-projection.mjs';

test('real PostgreSQL projection publishes in batches and preserves the newer local quote', {
  skip: process.env.RUN_ACCOUNTS_DB_TESTS !== '1',
}, async () => {
  const schema = `test_accounts_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE xero_customer_documents (
      contact_id text, document_type text, document_id text, document_number text, status text,
      document_date date,due_date date,reference text,currency_code text,total numeric,
      amount_paid numeric,amount_due numeric,payload jsonb,xero_updated_at timestamptz,
      synced_at timestamptz NOT NULL,PRIMARY KEY(contact_id,document_type,document_id));
      CREATE TABLE portal_quote_requests(contact_id text,quote_id text);
      CREATE TABLE xero_customer_document_sync_state(contact_id text PRIMARY KEY,
        last_successful_sync_at timestamptz,source_observed_at timestamptz,refresh_requested_at timestamptz,
        last_error text,updated_at timestamptz DEFAULT now())`);
    await pool.query(`INSERT INTO portal_quote_requests VALUES('company-a','local-quote');
      INSERT INTO xero_customer_documents(contact_id,document_type,document_id,document_number,reference,synced_at)
        VALUES('company-a','quote','local-quote','QU-new','Current reference','2026-10-06T12:00:00Z'),
        ('company-a','quote','historical-quote','QU-accepted','Confirmed acceptance','2026-10-06T12:00:00Z'),
        ('company-a','invoice','obsolete','INV-obsolete','old','2026-10-01T00:00:00Z'),
        ('company-b','invoice','other-company','INV-b','private','2026-10-01T00:00:00Z');
      INSERT INTO xero_customer_document_sync_state(contact_id,refresh_requested_at)
        VALUES('company-a','2026-10-06T13:00:00.123456Z')`);
    const invoices = Array.from({ length: 1105 }, (_, i) => ({ InvoiceID: `invoice-${i}`, InvoiceNumber: `INV-${i}`,
      Type: 'ACCREC', Contact: { ContactID: 'company-a' }, DateString: '2026-10-06', AmountDue: 10 }));
    const hub = async path => {
      const url = new URL(path, 'http://hub.invalid');
      const key = url.pathname.slice(1);
      const page = Number(url.searchParams.get('page'));
      const all = key === 'Invoices' ? invoices : key === 'Quotes' ? [{ QuoteID: 'local-quote', QuoteNumber: 'QU-old',
        Reference: 'Old reference', Contact: { ContactID: 'company-a' } },
      { QuoteID: 'historical-quote', QuoteNumber: 'QU-before-acceptance', Contact: { ContactID: 'company-a' } }] : [];
      return Response.json({ [key]: all.slice((page - 1) * 100, page * 100),
        _hub: { complete: true, snapshot: key,
          observed_at: key === 'Invoices' && page > 1 ? '2026-10-06T12:00:00Z' : '2026-10-06T11:00:00Z' } });
    };
    const result = await refreshAccountDocuments(pool, hub, 'company-a');
    assert.equal(result.count, 1107);
    const counts = await pool.query('SELECT contact_id,count(*)::int AS n FROM xero_customer_documents GROUP BY contact_id ORDER BY 1');
    assert.deepEqual(counts.rows, [{ contact_id: 'company-a', n: 1107 }, { contact_id: 'company-b', n: 1 }]);
    const quote = await pool.query("SELECT document_number,reference FROM xero_customer_documents WHERE document_id='local-quote'");
    assert.deepEqual(quote.rows[0], { document_number: 'QU-new', reference: 'Current reference' });
    const historicalQuote = await pool.query("SELECT document_number,reference FROM xero_customer_documents WHERE document_id='historical-quote'");
    assert.deepEqual(historicalQuote.rows[0], { document_number: 'QU-accepted', reference: 'Confirmed acceptance' });
    const invoiceObservations = await pool.query("SELECT min(synced_at) AS oldest,max(synced_at) AS newest FROM xero_customer_documents WHERE contact_id='company-a' AND document_type='invoice'");
    assert.equal(invoiceObservations.rows[0].oldest.toISOString(), '2026-10-06T11:00:00.000Z');
    assert.equal(invoiceObservations.rows[0].newest.toISOString(), '2026-10-06T11:00:00.000Z');
    const state = await pool.query('SELECT last_successful_sync_at,source_observed_at,refresh_requested_at FROM xero_customer_document_sync_state');
    assert.ok(state.rows[0].last_successful_sync_at);
    assert.equal(state.rows[0].source_observed_at.toISOString(), '2026-10-06T11:00:00.000Z');
    assert.equal(state.rows[0].refresh_requested_at, null);
    // An incomplete refresh must retain that entire published history.
    const incomplete = async () => Response.json({ Quotes: [], _hub: { complete: false } });
    await assert.rejects(refreshAccountDocuments(pool, incomplete, 'company-a'), /incomplete/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM xero_customer_documents WHERE contact_id='company-a'")).rows[0].n, 1107);
    assert.ok((await pool.query('SELECT last_error FROM xero_customer_document_sync_state')).rows[0].last_error);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
