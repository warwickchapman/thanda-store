import test from 'node:test';
import assert from 'node:assert/strict';
import { hubFetch, assertHubSnapshot } from '../src/lib/xero/hub.mjs';

test('service reads and explicit commands are routed to Hub with only service credentials', async () => {
  process.env.XERO_HUB_URL = 'http://local-hub';
  process.env.XERO_HUB_TOKEN = 'service-test';
  const calls = [];
  const prior = global.fetch;
  global.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ Invoices: [], _hub: { complete: true, observed_at: '2026-09-25T12:00:00Z', snapshot: '1' } })); };
  try {
    await hubFetch('/Invoices?page=1', { headers: { Authorization: 'old-secret', 'xero-tenant-id': 'old-tenant' } });
    assert.equal(calls[0].url, 'http://local-hub/v1/thanda-solar/accounting/Invoices?page=1');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer service-test');
    assert.equal(calls[0].init.headers['xero-tenant-id'], undefined);
    await hubFetch('/Quotes/id', { method: 'POST', headers: { 'Idempotency-Key': 'operation-123', 'X-Hub-Actor': 'user:1', 'X-Hub-Contact': 'contact' } });
    assert.equal(calls[1].url, 'http://local-hub/v1/thanda-solar/commands/quotes/id');
    assert.equal(calls[1].init.headers['idempotency-key'], 'operation-123');
    await hubFetch('/Invoices/id/pdf');
    assert.equal(calls[2].init.method, 'POST');
    assert.match(calls[2].url, /documents\/Invoices\/id\/pdf$/);
    await assert.rejects(hubFetch('https://api.xero.com/Invoices'), /Only local/);
    await assert.rejects(hubFetch('/Invoices', { method: 'POST' }), /Unsupported/);
    assert.equal(calls.length, 3);
  } finally { global.fetch = prior; }
});

test('incomplete and changing collections cannot replace a complete local snapshot', () => {
  assert.throws(() => assertHubSnapshot({}), /incomplete/);
  const payload = { _hub: { complete: true, observed_at: 'date', snapshot: '2' } };
  assert.equal(assertHubSnapshot(payload, '2'), '2');
  assert.throws(() => assertHubSnapshot(payload, '1'), /changed/);
});
