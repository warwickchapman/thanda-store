import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';
import { cacheCreatedQuote } from '../src/lib/commerce/quote-requests.mjs';

const source = fs.readFileSync(new URL('../src/lib/xero/customer-accounts.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText;
const user = { id: 7, organisationId: 2, xeroContactId: 'company-contact' };

function harness({ initial = false, pending = false } = {}) {
  const calls = [], hubCalls = [];
  const pool = { query: async (sql, args) => {
    calls.push({ sql, args: args && [...args] });
    if (sql.startsWith('INSERT INTO xero_customer_document_sync_state')) return { rows: [] };
    if (sql.startsWith('SELECT last_successful_sync_at,source_observed_at')) return { rows: [{
      last_successful_sync_at: initial ? null : new Date('2026-10-06T09:00:00Z'),
      source_observed_at: initial ? null : new Date('2026-10-06T08:00:00Z'),
      refresh_requested_at: pending ? new Date() : null,
      last_error: null,
    }] };
    if (sql.startsWith('SELECT COUNT(*)')) return { rows: [{ total: 1 }] };
    if (sql.includes('SUM(amount_due)')) return { rows: [{ open_invoices: 123, credit_available: 0 }] };
    if (sql.includes('SELECT document_type, document_id')) return { rows: [{
      document_type: 'quote', document_id: 'quote-1', document_number: 'QU-1', status: 'SENT',
      // PostgreSQL DATE at SAST midnight becomes the previous UTC day if the
      // application accidentally reads it as a JS Date instead of date text.
      document_date: sql.includes('document_date::text') ? '2026-10-06' : new Date('2026-10-06T00:00:00+02:00'),
      due_date: sql.includes('due_date::text') ? '2026-10-31' : new Date('2026-10-31T00:00:00+02:00'),
      reference: 'job', currency_code: 'ZAR', total: 12, amount_paid: 0, amount_due: 0,
    }] };
    if (sql.startsWith('INSERT INTO xero_customer_documents') || sql.includes('INSERT INTO portal_activity_log')) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const quote = { QuoteID: 'quote-1', QuoteNumber: 'QU-1', Status: 'SENT', Reference: 'job',
    DateString: '2026-10-06', Contact: { ContactID: user.xeroContactId }, LineItems: [{ Quantity: 1, UnitAmount: 12 }] };
  const modules = {
    'node:crypto': crypto,
    '@/lib/db': pool,
    '@/lib/auth/schema': { ensureAuthSchema: async () => {} },
    '@/lib/commerce/quote-requests.mjs': { cacheCreatedQuote },
    '@/lib/xero/oauth': { xeroAccountingFetch: async (path, init) => {
      hubCalls.push({ path, init });
      return Response.json({ Quotes: [{ ...quote, Status: init?.method === 'POST' ? 'ACCEPTED' : 'SENT' }] });
    } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => {
    assert.ok(name in modules, `Unexpected import ${name}`);
    return modules[name];
  }, Date, String, Number, JSON, Error, console });
  return { accounts: exports, calls, hubCalls };
}

test('manual refresh and cold Accounts reads return saved documents without awaiting any Hub import', async () => {
  for (const initial of [false, true]) {
    const h = harness({ initial, pending: true });
    const result = await h.accounts.customerDocumentsPage(user, { refresh: true });
    assert.equal(result.documents[0].number, 'QU-1');
    assert.equal(result.documents[0].date, '2026-10-06');
    assert.equal(result.sync.pending, true);
    assert.equal(result.sync.hasSnapshot, !initial);
    assert.equal(h.hubCalls.length, 0);
    const queue = h.calls.find(call => call.sql.startsWith('INSERT INTO xero_customer_document_sync_state'));
    assert.deepEqual(queue.args, [user.xeroContactId, true]);
  }
});

test('clearing quote focus restores invoice history with the same company boundary', async () => {
  const h = harness();
  await h.accounts.customerDocumentsPage(user, { quoteId: 'quote-1', view: 'current' });
  const focused = h.calls.find(call => call.sql.startsWith('SELECT COUNT(*)'));
  assert.match(focused.sql, /document_type='quote' AND document_id=/);
  assert.deepEqual(focused.args, [user.xeroContactId, 'quote-1']);
  h.calls.length = 0;
  await h.accounts.customerDocumentsPage(user, { view: 'invoice' });
  const history = h.calls.find(call => call.sql.startsWith('SELECT COUNT(*)'));
  assert.doesNotMatch(history.sql, /AND document_id=/);
  assert.deepEqual(history.args, [user.xeroContactId, 'invoice']);
  assert.equal(h.hubCalls.length, 0);
});

test('statement export cannot mistake an initial partial cache for complete account history', async () => {
  const h = harness({ initial: true, pending: true });
  await assert.rejects(h.accounts.customerDocuments(user), /Account history is being prepared/);
  assert.equal(h.hubCalls.length, 0);
});

test('full statement reads preserve calendar dates independently of the database client timezone', async () => {
  const h = harness();
  const documents = await h.accounts.customerDocuments(user);
  assert.equal(documents[0].date, '2026-10-06');
  assert.equal(documents[0].dueDate, '2026-10-31');
});

test('accepting a quote caches the confirmed result without importing all history in the action request', async () => {
  const h = harness();
  await h.accounts.updateQuoteAcceptance(user, 'quote-1', true);
  assert.equal(h.hubCalls.length, 2);
  assert.deepEqual(h.hubCalls.map(call => call.path), ['/Quotes/quote-1', '/Quotes/quote-1']);
  const cached = h.calls.find(call => call.sql.startsWith('INSERT INTO xero_customer_documents'));
  assert.equal(cached.args[0], user.xeroContactId);
  assert.equal(cached.args[3], 'ACCEPTED');
});
