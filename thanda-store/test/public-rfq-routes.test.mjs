import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as rfq from '../src/lib/commerce/public-rfq.mjs';
import { favouritesWindowStart } from '../src/lib/favourite-products.mjs';
import { selectPublicProducts } from '../src/lib/commerce/public-storefront.mjs';

const origin = 'https://store.thanda.solar';
const id = '4fd831c6-ec92-41ea-86b1-015af613b02c';
const products = [{ id: 1, supplier: 'victron', sku: 'PMP482305012', name: 'MultiPlus-II' },
  { id: 2, supplier: 'victron', sku: 'SCC115085211', name: 'SmartSolar MPPT' }];
const validBody = () => ({ requestId: id, startedAt: Date.now() - 5000, website: '',
  contact: { name: ' Warwick ', email: ' WARWICK@EXAMPLE.TEST ', phone: ' 0123456789 ', company: ' Example ', town: ' Ballito ' },
  deliveryPreference: 'deliver', message: ' Please advise. ', lines: [{ productId: 1, quantity: 2 }] });

// Execute the actual Next handler. Authentication and persistence are mocked;
// the real body reader, origin checks and RFQ normalization remain in use.
function evaluate(file, dependencies) {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const loadedModule = { exports: {} };
  new Function('require', 'module', 'exports', 'fetch', compiled)(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, loadedModule, loadedModule.exports, () => { throw new Error('Network access is forbidden.'); });
  return loadedModule.exports;
}

function harness({ user = { id: 7, role: 'admin' }, recordError, listError, resumeReceipt = null,
  currentProducts = products, catalogueError } = {}) {
  const calls = { catalogue: 0, schema: 0, resumptions: [], records: [], lists: 0, sql: [] };
  const pool = { query: async (text, args) => {
    calls.sql.push({ text, args });
    assert.match(text, /^UPDATE guest_quote_requests /, 'Unexpected database access.');
    return { rows: [{ id }], rowCount: 1 };
  } };
  const dependencies = {
    '@/lib/db': pool,
    '@/lib/auth/server': { currentUser: async () => user },
    '@/lib/commerce/public-storefront': { publicFeaturedProducts: async () => {
      calls.catalogue++;
      if (catalogueError) throw catalogueError;
      return currentProducts;
    } },
    '@/lib/commerce/public-rfq.mjs': { ...rfq,
      ensurePublicRfqSchema: async () => { calls.schema++; },
      resumePublicRfq: async (...args) => { calls.resumptions.push(args); return resumeReceipt; },
      recordPublicRfq: async (...args) => {
        calls.records.push(args);
        if (recordError) throw recordError;
        return { reference: args[1].id, status: 'received' };
      },
      listPublicRfqs: async () => {
        calls.lists++;
        if (listError) throw listError;
        return [{ id, contact: { name: 'Private customer', email: 'private@example.test' } }];
      },
    },
  };
  return { calls, pool,
    publicRoute: evaluate('app/api/public/quote-requests/route.ts', dependencies),
    adminRoute: evaluate('app/api/admin/guest-quote-requests/route.ts', dependencies),
  };
}

function request(body = validBody(), { path = '/api/public/quote-requests', method = 'POST',
  requestOrigin = origin, raw, headers = {} } = {}) {
  return new Request(`${origin}${path}`, { method,
    headers: { 'content-type': 'application/json', ...(requestOrigin === null ? {} : { origin: requestOrigin }), ...headers },
    body: raw === undefined ? JSON.stringify(body) : raw });
}
const assertNoWrites = h => {
  assert.equal(h.calls.schema, 0);
  assert.equal(h.calls.records.length, 0);
  assert.equal(h.calls.sql.length, 0);
};

test('featured products are readable without account dependencies and a failed read exposes no internal error', async () => {
  const publicCatalogue = { '@/lib/commerce/public-storefront': { publicFeaturedProducts: async () => products } };
  const route = evaluate('app/api/public/featured-products/route.ts', publicCatalogue);
  const response = await route.GET();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).selection, 'popular');
  assert.match(response.headers.get('cache-control'), /^public,/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const failed = evaluate('app/api/public/featured-products/route.ts', {
    '@/lib/commerce/public-storefront': { publicFeaturedProducts: async () => { throw new Error('PRIVATE-DATABASE-DETAIL'); } },
  });
  const failure = await failed.GET();
  assert.equal(failure.status, 503);
  assert.equal(failure.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await failure.text(), /PRIVATE-DATABASE-DETAIL/);
});

test('the public range reads local sales in the shared Popular period without provider calls or schema writes', async () => {
  const queries = [];
  const catalogue = evaluate('lib/commerce/public-storefront.ts', {
    'node:fs': { existsSync: () => false }, 'node:path': { join: (...parts) => parts.join('/') },
    '@/lib/db': { query: async (sql, parameters) => {
      assert.match(sql, /^SELECT /, 'The public range must only read existing local data.');
      queries.push({ sql, parameters });
      if (sql.includes('FROM products')) return { rows: [
        { id: 1, supplier: 'victron', sku: 'FIRST', name: 'First', details: {} },
        { id: 2, supplier: 'victron', sku: 'SECOND', name: 'Second', details: {} },
      ] };
      assert.match(sql, /FROM xero_sales_invoice_lines\s+WHERE invoice_date >= \$1::date/);
      return { rows: [
        { invoice_id: 'PRIVATE-INVOICE', invoice_date: new Date(), sku: 'FIRST', quantity: 2 },
        { invoice_id: 'PRIVATE-CUSTOMER-INVOICE', invoice_date: new Date(), sku: 'SECOND', quantity: 5 },
      ] };
    } },
    '../../../data/public-product-summaries.json': [{ supplier: 'victron', sku: 'FIRST', position: 1, summary: 'Reviewed copy.' }],
    '@/lib/sku-successions.mjs': { loadSkuSuccessions: async () => [] },
    '@/lib/favourite-products.mjs': { favouritesWindowStart },
    './public-storefront.mjs': { selectPublicProducts },
  });
  const result = await catalogue.publicFeaturedProducts();
  assert.deepEqual(result.map(row => row.id), [2, 1]);
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[1].parameters, [favouritesWindowStart()]);
  assert.doesNotMatch(queries[0].sql, /\bprice\b|description|contact_id/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|invoice_id|quantity|contact_id/);
});

test('featured feed CORS permits only the four configured marketing origins without credentials', async () => {
  const route = evaluate('app/api/public/featured-products/route.ts', {
    '@/lib/commerce/public-storefront': { publicFeaturedProducts: async () => products },
  });
  const allowed = ['https://dev.thanda.solar', 'https://thanda.solar', 'https://www.thanda.solar', 'http://127.0.0.1:18774'];
  for (const requestOrigin of allowed) {
    const req = new Request(`${origin}/api/public/featured-products`, { headers: { origin: requestOrigin } });
    for (const response of [await route.GET(req), await route.OPTIONS(req)]) {
      assert.equal(response.headers.get('access-control-allow-origin'), requestOrigin);
      assert.equal(response.headers.get('access-control-allow-credentials'), null);
      assert.equal(response.headers.get('vary'), 'Origin');
    }
    const preflight = await route.OPTIONS(req);
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  }
  for (const requestOrigin of [null, 'null', 'https://untrusted.example', 'https://thanda.solar.evil.test',
    'https://thanda.solar/path', 'http://127.0.0.1:18775']) {
    const req = new Request(`${origin}/api/public/featured-products`, {
      headers: requestOrigin === null ? {} : { origin: requestOrigin },
    });
    const response = await route.GET(req);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    assert.equal(response.headers.get('vary'), 'Origin');
    assert.equal((await route.OPTIONS(req)).status, 403);
  }
});

test('normalization takes product identity from the current public selection and ignores forged fields', () => {
  const body = validBody();
  body.lines = [{ productId: 2, quantity: 1, sku: 'FAKE', supplier: 'FAKE', name: 'FAKE', price: 0.01 },
    { productId: 1, quantity: 2 }];
  body.to = 'attacker@example.test';
  body.contact.discount = 99;
  const result = rfq.normalizeRfq(body, products);
  assert.deepEqual(result, { id, contact: { name: 'Warwick', email: 'warwick@example.test', phone: '0123456789', company: 'Example', town: 'Ballito' },
    deliveryPreference: 'deliver', message: 'Please advise.',
    lines: [{ productId: 1, supplier: 'victron', sku: 'PMP482305012', name: 'MultiPlus-II', quantity: 2 },
      { productId: 2, supplier: 'victron', sku: 'SCC115085211', name: 'SmartSolar MPPT', quantity: 1 }] });
});

test('invalid identity, timing, contact, honeypot and line inputs cannot become enquiries', () => {
  const mutations = [
    body => { body.requestId = 'not-a-uuid'; }, body => { body.requestId = id.replace('-41ea-', '-11ea-'); },
    body => { body.website = 'https://bot.example'; }, body => { body.startedAt = Date.now(); },
    body => { body.startedAt = Date.now() - 86_400_001; }, body => { body.startedAt = Date.now() + 5000; },
    body => { body.startedAt = NaN; }, body => { body.contact.name = ''; },
    body => { body.contact.email = 'x@example.test\r\nBcc: attacker@example.test'; },
    body => { body.contact.email = 'bad'; }, body => { body.contact.town = ''; },
    body => { body.contact.company = 'x'.repeat(161); }, body => { body.message = 'x'.repeat(2001); },
    body => { body.deliveryPreference = 'free'; }, body => { body.lines = []; body.message = ''; },
    body => { body.lines = Array.from({ length: 9 }, (_, index) => ({ productId: index + 1, quantity: 1 })); },
    body => { body.lines[0].quantity = 0; }, body => { body.lines[0].quantity = 101; },
    body => { body.lines[0].quantity = 1.5; }, body => { body.lines[0].quantity = '2'; },
    body => { body.lines[0].productId = '1'; }, body => { body.lines.push({ ...body.lines[0] }); },
  ];
  for (const mutate of mutations) {
    const body = validBody(); mutate(body);
    assert.throws(() => rfq.normalizeRfq(body, products), error => error instanceof rfq.RfqError && error.status === 400,
      mutate.toString());
  }
  assert.throws(() => rfq.normalizeRfq(validBody(), []), error => error instanceof rfq.RfqError && error.status === 409);
});

test('body reader enforces actual UTF-8 byte limits even with absent or understated Content-Length', async () => {
  for (const headers of [{}, { 'content-length': '1' }]) {
    const body = JSON.stringify({ message: '🌞'.repeat(4200) });
    await assert.rejects(() => rfq.readRfqJson(request(null, { raw: body, headers })),
      error => error instanceof rfq.RfqError && error.status === 413);
  }
  assert.deepEqual(await rfq.readRfqJson(request({ message: 'A small enquiry' })), { message: 'A small enquiry' });
  for (const raw of ['invalid JSON', 'null', '[]']) {
    await assert.rejects(() => rfq.readRfqJson(request(null, { raw })), error => error instanceof rfq.RfqError && error.status === 400);
  }
});

test('foreign, malformed and absent origins fail before the public catalogue or ledger is touched', async () => {
  for (const requestOrigin of [null, 'https://thanda.solar', 'https://store.thanda.solar.evil.test', `${origin}/path`, 'null']) {
    const h = harness();
    const response = await h.publicRoute.POST(request(undefined, { requestOrigin }));
    assert.equal(response.status, 403, String(requestOrigin));
    assert.equal(h.calls.catalogue, 0);
    assertNoWrites(h);
  }
});

test('production reverse-proxy URLs use the configured public origin without trusting forwarded hosts', async () => {
  const previous = { nodeEnv: process.env.NODE_ENV, portalBaseUrl: process.env.PORTAL_BASE_URL };
  const proxyRequest = requestOrigin => new Request('http://localhost:3000/api/public/quote-requests', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: requestOrigin,
      'x-forwarded-host': 'attacker.example', forwarded: 'host=attacker.example;proto=https' },
    body: JSON.stringify(validBody()),
  });
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.PORTAL_BASE_URL;
    const h = harness({ user: null });
    assert.equal((await h.publicRoute.POST(proxyRequest(origin))).status, 202);
    assert.equal(h.calls.records.length, 1);
    for (const requestOrigin of [`${origin}/path`, 'http://localhost:3000', 'https://attacker.example', 'invalid origin']) {
      assert.throws(() => rfq.requireRfqOrigin(proxyRequest(requestOrigin)),
        error => error instanceof rfq.RfqError && error.status === 403, requestOrigin);
    }
    process.env.PORTAL_BASE_URL = 'http://127.0.0.1:18775';
    assert.doesNotThrow(() => rfq.requireRfqOrigin(proxyRequest('http://127.0.0.1:18775')));
    assert.throws(() => rfq.requireRfqOrigin(proxyRequest(origin)),
      error => error instanceof rfq.RfqError && error.status === 403);
  } finally {
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.portalBaseUrl === undefined) delete process.env.PORTAL_BASE_URL;
    else process.env.PORTAL_BASE_URL = previous.portalBaseUrl;
  }
});

test('malformed and oversized public submissions are rejected before any catalogue or ledger access', async () => {
  for (const [raw, expected] of [['invalid JSON', 400], [JSON.stringify({ huge: 'x'.repeat(16_384) }), 413]]) {
    const h = harness();
    assert.equal((await h.publicRoute.POST(request(null, { raw }))).status, expected);
    assert.equal(h.calls.catalogue, 0);
    assertNoWrites(h);
  }
  const h = harness();
  const body = validBody(); body.lines[0].quantity = -1;
  assert.equal((await h.publicRoute.POST(request(body))).status, 400);
  assert.equal(h.calls.catalogue, 0);
  assertNoWrites(h);
});

test('a guest can receive only a minimal receipt without an authenticated account or accounting write', async () => {
  const h = harness({ user: null });
  const response = await h.publicRoute.POST(request(validBody(), { headers: { cookie: 'thanda_session=expired' } }));
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { reference: id, status: 'received' });
  assert.equal(h.calls.schema, 1);
  assert.equal(h.calls.records.length, 1);
  assert.equal(h.calls.records[0][0], h.pool);
  assert.equal(h.calls.records[0][1].contact.email, 'warwick@example.test');
  assert.equal(h.calls.sql.length, 0, 'Only the RFQ boundary may persist a guest enquiry.');
});

test('general solution and LoRa enquiries need a message and can be submitted without reading the product catalogue', async () => {
  const body = validBody();
  body.lines = [];
  body.message = ' Please help plan a LoRa tank monitoring system. ';
  body.deliveryPreference = 'discuss';
  const canonical = rfq.normalizeRfq(body, []);
  assert.deepEqual(canonical.lines, []);
  assert.equal(canonical.message, 'Please help plan a LoRa tank monitoring system.');
  const h = harness({ user: null });
  const response = await h.publicRoute.POST(request(body));
  assert.equal(response.status, 202);
  assert.equal(h.calls.catalogue, 0);
  assert.equal(h.calls.records.length, 1);
  assert.deepEqual(h.calls.records[0][1].lines, []);
  const invalid = harness({ user: null });
  body.message = '   ';
  assert.equal((await invalid.publicRoute.POST(request(body))).status, 400);
  assert.equal(invalid.calls.catalogue, 0);
  assertNoWrites(invalid);
});

test('a lost submission reply can be recovered after a title edit, hidden selection or replacement without a catalogue read', async () => {
  const receipt = { reference: id, status: 'received' };
  for (const currentProducts of [[{ ...products[0], name: 'Edited product title' }], [],
    [{ ...products[0], id: 3, sku: 'PMP482305014', name: 'Replacement article' }]]) {
    const h = harness({ user: null, resumeReceipt: receipt, currentProducts,
      catalogueError: new Error('A saved receipt must not depend on current catalogue availability.') });
    const body = validBody();
    body.startedAt = Date.now() - 2 * 86_400_000;
    body.lines[0].name = 'Original product title';
    body.lines[0].sku = 'PMP482305012';
    const response = await h.publicRoute.POST(request(body));
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), receipt);
    assert.equal(h.calls.catalogue, 0);
    assert.equal(h.calls.records.length, 0);
    assert.equal(h.calls.resumptions.length, 1);
    assert.deepEqual(h.calls.resumptions[0][1].lines, [{ productId: 1, quantity: 2 }]);
  }
});

test('a new reference must still pass current product eligibility and timing checks before any enquiry is recorded', async () => {
  for (const currentProducts of [[], [{ ...products[0], id: 3, sku: 'PMP482305014', name: 'Replacement article' }]]) {
    const h = harness({ currentProducts });
    const body = validBody(); body.requestId = '4fd831c6-ec92-41ea-86b1-015af613b02d';
    assert.equal((await h.publicRoute.POST(request(body))).status, 409);
    assert.equal(h.calls.resumptions.length, 1);
    assert.equal(h.calls.catalogue, 1);
    assert.equal(h.calls.records.length, 0);
  }
  const h = harness();
  const body = validBody(); body.startedAt = Date.now() - 2 * 86_400_000;
  assert.equal((await h.publicRoute.POST(request(body))).status, 400);
  assert.equal(h.calls.records.length, 0);
});

test('rate-limited and failed public saves return useful bounded errors without provider details', async () => {
  const limited = harness({ recordError: new rfq.RfqError(429, 'Too many enquiries.') });
  const response = await limited.publicRoute.POST(request());
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
  const failed = harness({ recordError: new Error('PRIVATE-SQL-OR-CREDENTIAL') });
  const failure = await failed.publicRoute.POST(request());
  assert.equal(failure.status, 503);
  assert.doesNotMatch(await failure.text(), /PRIVATE-SQL-OR-CREDENTIAL/);
});

test('guest contact information is visible only to an actual administrator', async () => {
  for (const user of [null, { id: 7, role: 'buyer' }, { id: 7, role: 'admin', impersonatedBy: { id: 9 } }]) {
    const h = harness({ user });
    for (const response of [await h.adminRoute.GET(), await h.adminRoute.PATCH(request({ id, status: 'quoted' },
      { path: '/api/admin/guest-quote-requests', method: 'PATCH' }))]) {
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('vary'), 'Cookie');
      assert.doesNotMatch(await response.text(), /private@example.test/);
    }
    assertNoWrites(h);
    assert.equal(h.calls.lists, 0);
  }
  const h = harness();
  const response = await h.adminRoute.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal((await response.json()).requests[0].contact.email, 'private@example.test');
});

test('admin changes require same-origin requests and record a validated status, notes and acting admin', async () => {
  const rejected = harness();
  assert.equal((await rejected.adminRoute.PATCH(request({ id, status: 'quoted' }, {
    path: '/api/admin/guest-quote-requests', method: 'PATCH', requestOrigin: 'https://untrusted.example',
  }))).status, 403);
  assertNoWrites(rejected);
  const h = harness();
  const response = await h.adminRoute.PATCH(request({ id, status: 'in_review', notes: ' Called customer. ' }, {
    path: '/api/admin/guest-quote-requests', method: 'PATCH',
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls.sql[0].args, [id, 'in_review', 'Called customer.', 7]);
  const noDb = { query: async () => { throw new Error('Invalid updates must not query the database.'); } };
  for (const body of [{ id: 'invalid', status: 'new' }, { id, status: 'accepted' }, { id, status: 'new', notes: 'x'.repeat(2001) }]) {
    await assert.rejects(() => rfq.updatePublicRfq(noDb, body, 7), error => error instanceof rfq.RfqError && error.status === 400);
  }
});

test('proxy headers cannot mint new anonymous identities unless trusted proxy handling is enabled', () => {
  const previous = process.env.PUBLIC_RFQ_TRUST_PROXY;
  try {
    delete process.env.PUBLIC_RFQ_TRUST_PROXY;
    const first = rfq.rfqClientKey(request(undefined, { headers: { 'x-real-ip': '192.0.2.1', 'x-forwarded-for': '192.0.2.1' } }));
    assert.equal(first, rfq.rfqClientKey(request(undefined, { headers: { 'x-real-ip': '192.0.2.2', 'x-forwarded-for': '192.0.2.2' } })));
    process.env.PUBLIC_RFQ_TRUST_PROXY = '1';
    const trusted = rfq.rfqClientKey(request(undefined, { headers: { 'x-real-ip': '192.0.2.1' } }));
    assert.notEqual(trusted, first);
    assert.equal(first, rfq.rfqClientKey(request(undefined, { headers: { 'x-real-ip': 'invalid', 'x-forwarded-for': '192.0.2.1' } })));
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_RFQ_TRUST_PROXY;
    else process.env.PUBLIC_RFQ_TRUST_PROXY = previous;
  }
});

test('only the quote form joins the public pages; the existing storefront still redirects guests to login', () => {
  const next = { next: () => Response.json({ next: true }), redirect: url => Response.redirect(url, 307) };
  const middleware = evaluate('middleware.ts', { 'next/server': { NextResponse: next } }).default;
  for (const cookie of ['', 'thanda_session=expired']) {
    assert.equal(middleware(new Request(`${origin}/request-quote`, { headers: { cookie } })).status, 200);
    for (const page of ['/login', '/forgot-password', '/set-password']) {
      assert.equal(middleware(new Request(`${origin}${page}`, { headers: { cookie } })).status, 200);
    }
  }
  for (const path of ['/', '/account', '/admin', '/request-quote/private']) {
    const response = middleware(new Request(`${origin}${path}`));
    assert.equal(response.status, 307, path);
    assert.equal(new URL(response.headers.get('location')).pathname, '/login');
  }
});
