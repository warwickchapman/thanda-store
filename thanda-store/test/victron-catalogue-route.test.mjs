import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { submitCatalogueCommand } from '../src/lib/victron-catalogue-command.mjs';
import { validCustomerViewOrigin } from '../src/lib/auth/impersonation-origin.mjs';

// Exercise the actual Next route with real Web Request/Response objects. Only
// auth, stored evidence and I/O are replaced; command/audit handling is real.
const source = fs.readFileSync(new URL('../src/app/api/admin/victron-catalogue/route.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText;
const product = { fingerprint: 'comparison-fingerprint', company: 'thanda-solar', sku: 'ASS030720118', name: 'Victron cable',
  cost: 144.9, list: 276, proposed: 144.9, observedAt: new Date().toISOString(), kind: 'price', itemId: 'item-1', previous: 165.38 };
const single = { action: 'apply', fingerprint: product.fingerprint };
const batch = { action: 'apply-batch', fingerprints: [product.fingerprint] };

function harness(options = {}) {
  const rows = options.rows || [product];
  const audit = [], calls = [];
  let refreshes = 0, schemaCalls = 0;
  const pool = { query: async (sql, args) => {
    if (sql.startsWith('INSERT INTO victron_catalogue_events')) {
      if (options.failAttempt) throw new Error('database internal failure');
      audit.push({ action: args[1], company: args[2], sku: args[3], details: JSON.parse(args[4]) });
      return { rows: [{ id: 42 }] };
    }
    if (sql.startsWith('UPDATE victron_catalogue_events')) {
      if (options.failOutcome) throw new Error('database internal failure');
      assert.equal(args[0], 42);
      audit.push({ action: args[1], details: JSON.parse(args[2]) });
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const request = async (company, path, init) => {
    assert.equal(audit.length, 1, 'an attempt must exist before any Hub dispatch');
    const payload = JSON.parse(init.body);
    assert.deepEqual(payload, audit[0].details.request.payload, 'the exact dispatch is persisted');
    assert.equal(init.headers['X-Hub-Actor'], '7');
    calls.push({ company, path, payload });
    if (options.respond) return options.respond();
    return Response.json({ Items: rows.map(row => ({ Code: row.sku, ItemID: row.itemId || 'new-item', PurchaseDetails: { UnitPrice: row.proposed } })) });
  };
  const modules = {
    'next/server': { NextResponse: Response },
    '@/lib/db': pool,
    '@/lib/auth/server': { currentUser: async () => options.user === undefined ? { id: 7, role: 'admin' } : options.user },
    '@/lib/auth/impersonation-origin.mjs': { validCustomerViewOrigin },
    '@/lib/victron-catalogue-service.mjs': { refreshReview: async () => {
      refreshes++;
      if (options.failRefresh && refreshes > 1) throw new Error('stored read failed');
      return { rows };
    } },
    '@/lib/victron-catalogue-command.mjs': { submitCatalogueCommand: (db, command) => submitCatalogueCommand(db, command, request) },
    '@/lib/victron-catalogue-review.mjs': { ensureReviewSchema: async () => { schemaCalls++; } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => {
    assert.ok(name in modules, `Unexpected import ${name}`);
    return modules[name];
  }, process: { env: { NODE_ENV: 'production' } }, Request, Response, Date, Set, JSON, Error, URL });
  return { audit, calls, schemaCalls: () => schemaCalls, post: async (body = single) => {
    const response = await exports.POST(new Request('https://store.thanda.solar/api/admin/victron-catalogue', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: options.origin || 'https://store.thanda.solar' }, body: JSON.stringify(body),
    }));
    return { status: response.status, headers: response.headers, body: await response.json() };
  } };
}

for (const [name, body] of [['single', single], ['batch', batch]]) {
  test(`${name}: plain-text Hub500 is audited as uncertain without exposing parser/internal errors`, async () => {
    const h = harness({ respond: () => new Response('Internal Server Error', { status: 500 }) });
    const result = await h.post(body);
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'UNKNOWN_OUTCOME');
    assert.match(result.body.error, /Do not repeat/);
    assert.doesNotMatch(result.body.error, /Unexpected token|Internal Server Error/);
    assert.deepEqual(h.audit.map(a => a.action), name === 'batch' ? ['batch-pending', 'batch-unknown'] : ['pending', 'unknown']);
    assert.equal(h.calls.length, 1);
  });
  test(`${name}: confirmed outcome retains the exact reviewed prices and a fresh command identity`, async () => {
    const h = harness();
    const result = await h.post(body);
    assert.equal(result.status, 200);
    assert.match(result.body.message, /Xero confirmed/);
    assert.equal(h.calls[0].company, product.company);
    const sent = name === 'batch' ? h.calls[0].payload.proposals[0] : h.calls[0].payload;
    assert.match(sent.requestId, /^[a-f0-9]{64}$/);
    assert.notEqual(sent.requestId, product.fingerprint);
    assert.equal(sent.expectedCost, product.previous);
    assert.equal(sent.cost, product.cost);
    assert.equal(sent.list, product.list);
    assert.equal(sent.observedAt, product.observedAt);
    assert.equal(h.audit[1].action, name === 'batch' ? 'batch-applied' : 'applied');
    const second = harness();
    await second.post(body);
    const another = name === 'batch' ? second.calls[0].payload.proposals[0] : second.calls[0].payload;
    assert.notEqual(sent.requestId, another.requestId, 'later legitimate price cycles must not replay an old command');
  });
}

for (const [name, respond] of [
  ['connection timeout', () => { throw new Error('internal socket details'); }],
  ['invalid success response', () => new Response('<html>proxy failure</html>')],
  ['wrong confirmed cost', () => Response.json({ Items: [{ Code: product.sku, ItemID: product.itemId, PurchaseDetails: { UnitPrice: 1 } }] })],
  ['JSON server failure', () => Response.json({ detail: 'private server exception' }, { status: 500 })],
]) test(`${name}: one attempt, no automatic retry, safe uncertain response`, async () => {
  const h = harness({ respond });
  const result = await h.post();
  assert.equal(result.body.code, 'UNKNOWN_OUTCOME');
  assert.doesNotMatch(result.body.error, /internal|private|proxy/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.audit.at(-1).action, 'unknown');
});

test('audit failure before dispatch prevents the write', async () => {
  const h = harness({ failAttempt: true });
  const result = await h.post();
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'NOT_SENT');
  assert.equal(h.calls.length, 0);
});
for (const option of ['failOutcome', 'failRefresh']) test(`${option}: confirmed Xero success is not misreported as a failed write`, async () => {
  const h = harness({ [option]: true });
  const result = await h.post();
  assert.equal(result.status, 200);
  assert.match(result.body.message, /Xero confirmed/);
  assert.match(result.body.message, /could not/);
  assert.equal(h.calls.length, 1);
});

test('Hub validation rejection and Retry-After remain actionable and audited', async () => {
  const h = harness({ respond: () => Response.json({ detail: 'Wait 15 seconds between item actions' }, { status: 429, headers: { 'Retry-After': '60' } }) });
  const result = await h.post();
  assert.equal(result.status, 429);
  assert.equal(result.body.code, 'COMMAND_REJECTED');
  assert.match(result.body.error, /Wait 15 seconds/);
  assert.equal(result.headers.get('Retry-After'), '60');
  assert.equal(h.audit.at(-1).action, 'rejected');
});
test('Hub uncertainty guard is conveyed as uncertainty, not an ordinary retryable rejection', async () => {
  const h = harness({ respond: () => Response.json({ detail: 'An earlier operation for one of these SKUs needs reconciliation' }, { status: 409 }) });
  const result = await h.post();
  assert.equal(result.body.code, 'UNKNOWN_OUTCOME');
  assert.equal(h.audit.at(-1).action, 'unknown');
});
test('explicit Hub deferral preserves its safe reason and Retry-After without claiming an uncertain write', async () => {
  const h = harness({ respond: () => Response.json({ code: 'DEFERRED', detail: 'Wait before sending another item action' }, { status: 503, headers: { 'Retry-After': '60' } }) });
  const result = await h.post();
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'DEFERRED');
  assert.equal(result.body.error, 'Wait before sending another item action');
  assert.equal(result.headers.get('Retry-After'), '60');
  assert.equal(h.audit.at(-1).action, 'rejected');
  assert.equal(h.calls.length, 1);
});
test('changed review selection is rejected before audit or Hub dispatch', async () => {
  const h = harness({ rows: [{ ...product, fingerprint: 'changed-price' }] });
  const result = await h.post();
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'STALE_SELECTION');
  assert.equal(h.calls.length, 0);
  assert.equal(h.audit.length, 0);
});
test('mixed company batch is rejected before dispatch', async () => {
  const other = { ...product, fingerprint: 'sensible', company: 'sensible-solar' };
  const h = harness({ rows: [product, other] });
  const result = await h.post({ action: 'apply-batch', fingerprints: [product.fingerprint, other.fingerprint] });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'INVALID_SELECTION');
  assert.equal(h.calls.length, 0);
});
test('Sensible command retains its tenant and list policy inputs', async () => {
  const row = { ...product, company: 'sensible-solar', proposed: 165.6 };
  const h = harness({ rows: [row] });
  assert.equal((await h.post()).status, 200);
  assert.equal(h.calls[0].company, 'sensible-solar');
  assert.equal(h.calls[0].payload.cost, product.cost);
  assert.equal(h.calls[0].payload.list, product.list);
});
for (const [name, options] of [
  ['anonymous', { user: null }], ['customer', { user: { id: 7, role: 'customer' } }],
  ['impersonated admin', { user: { id: 7, role: 'admin', impersonatedBy: 9 } }],
  ['cross origin', { origin: 'https://unrelated.invalid' }],
]) test(`${name}: forbidden before database or Hub access`, async () => {
  const h = harness(options);
  assert.equal((await h.post()).status, 403);
  assert.equal(h.schemaCalls(), 0);
  assert.equal(h.calls.length, 0);
});
