import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { validCustomerViewOrigin } from '../src/lib/auth/impersonation-origin.mjs';
import { RenogySkuSuccessionInputError } from '../src/lib/renogy-sku-successions.mjs';

// Execute the route with the real origin check. Only session and PostgreSQL I/O
// are replaced; no supplier or Xero client is available to this admin workflow.
const compiled = ts.transpileModule(fs.readFileSync(new URL('../src/app/api/admin/renogy-sku-successions/route.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;

function harness(options = {}) {
  const calls = [];
  const invoke = async (operation, input) => {
    calls.push({ operation, input });
    if (options.error) throw options.error;
    return operation === 'list' ? { products: [], successions: [] } : { predecessorSku: input?.predecessorSku, successorSku: input?.successorSku };
  };
  const modules = {
    '@/lib/auth/server': { currentUser: async () => options.user === undefined ? { role: 'admin', email: 'admin@example.test' } : options.user },
    '@/lib/auth/impersonation-origin.mjs': { validCustomerViewOrigin },
    '@/lib/db': {},
    '@/lib/renogy-sku-successions.mjs': {
      RenogySkuSuccessionInputError,
      listRenogySkuSuccessions: async () => invoke('list'),
      saveRenogySkuSuccession: async (_db, input) => invoke('save', input),
      removeRenogySkuSuccession: async (_db, input) => invoke('remove', input),
    },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected import ${name}`);
    return modules[name];
  }, Response, Error, process: { env: { NODE_ENV: 'production' } } });
  return { calls, request: async (method, body = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (options.origin !== null) headers.Origin = options.origin || 'https://store.thanda.solar';
    const response = await exports[method](new Request('https://store.thanda.solar/api/admin/renogy-sku-successions', {
      method, headers, ...(method === 'GET' ? {} : { body: options.rawBody ?? JSON.stringify(body) }),
    }));
    return { status: response.status, headers: response.headers, body: await response.json() };
  } };
}

test('Renogy replacement reads and changes require an actual admin before database I/O', async () => {
  for (const user of [null, { role: 'buyer' }, { role: 'admin', impersonatedBy: { id: 7 } }]) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const h = harness({ user });
      assert.equal((await h.request(method)).status, 403);
      assert.equal(h.calls.length, 0);
    }
  }
});

test('Renogy replacement mutations reject cross-origin requests and malformed JSON locally', async () => {
  for (const method of ['POST', 'DELETE']) {
    for (const origin of [null, 'https://untrusted.example', 'https://store.thanda.solar/path']) {
      const h = harness({ origin });
      assert.equal((await h.request(method)).status, 403);
      assert.equal(h.calls.length, 0);
    }
    const malformed = harness({ rawBody: '{invalid' });
    assert.equal((await malformed.request(method)).status, 400);
    assert.equal(malformed.calls.length, 0);
  }
});

test('Renogy listing is private and replacement evidence comes from the authenticated administrator', async () => {
  const h = harness();
  const listing = await h.request('GET');
  assert.equal(listing.status, 200);
  assert.equal(listing.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(listing.body, { products: [], successions: [] });
  const pair = { predecessorSku: 'RBT12100LFP-M-G1-SA', successorSku: 'RBT12100LFP-M-G2-SA', sourceDescription: 'Forged supplier confirmation' };
  assert.equal((await h.request('POST', pair)).status, 200);
  assert.equal(h.calls[1].operation, 'save');
  assert.equal(h.calls[1].input.sourceDescription, 'Manual entry by administrator (admin@example.test)');
  assert.equal(h.calls[1].input.predecessorSku, pair.predecessorSku);
  assert.equal(h.calls[1].input.successorSku, pair.successorSku);
  assert.equal((await h.request('DELETE', pair)).status, 200);
  assert.equal(h.calls[2].operation, 'remove');
});

test('Renogy replacement route exposes useful validation errors and safe uncertain outcomes', async () => {
  for (const status of [400, 404, 409]) {
    const h = harness({ error: new RenogySkuSuccessionInputError('Check the saved link.', status) });
    const response = await h.request('POST', {});
    assert.equal(response.status, status);
    assert.equal(response.body.error, 'Check the saved link.');
  }
  const h = harness({ error: new Error('Private database failure details') });
  const response = await h.request('POST', {});
  assert.equal(response.status, 503);
  assert.match(response.body.error, /Unable to confirm/);
  assert.doesNotMatch(response.body.error, /Private database/);
});
