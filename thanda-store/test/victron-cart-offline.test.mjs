import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Execute the actual route with in-memory auth/DB boundaries and a supplier
// transport that fails if called. No provider or production DB is contacted.
const route = readFileSync(new URL('../src/app/api/admin/victron-provisional-cart/route.ts', import.meta.url), 'utf8');
const parser = readFileSync(new URL('../src/lib/victron-provisional-cart.ts', import.meta.url), 'utf8');
function evaluate(source, dependencies) {
  const module = { exports: {} };
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', 'fetch', js)(name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports, () => { throw new Error('Supplier requests are forbidden'); });
  return module.exports;
}
test('cart upload saves known and unknown SKUs without contacting a rate-limited supplier', async () => {
  const queries = [];
  const client = { query: async (...args) => { queries.push(args); }, release() {} };
  const api = evaluate(route, {
    'next/server': { NextResponse: { json: body => body } },
    '@/lib/db': { default: { connect: async () => client } },
    '@/lib/auth/server': { currentUser: async () => ({ role: 'admin' }) },
    '@/lib/auth/schema': { ensureAuthSchema: async () => {} },
    '@/lib/victron-provisional-cart': evaluate(parser, {}),
  });
  const form = new FormData();
  form.set('cartHtml', new File(['<input id="quantity-PMP482305010" value="2"><input id="quantity-PMR482602030" value="1">'], 'cart.html'));
  const result = await api.POST({ formData: async () => form });
  assert.deepEqual(result, { ok: true, lineCount: 2 });
  assert.deepEqual(queries.filter(([sql]) => sql.startsWith('INSERT')).map(([, values]) => values), [['PMP482305010', 2], ['PMR482602030', 1]]);
  assert.equal(queries.at(-1)[0], 'COMMIT');
});
