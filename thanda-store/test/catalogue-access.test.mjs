import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as access from '../src/lib/catalogue-access.mjs';
import * as exportTools from '../src/lib/commerce/catalogue-export.mjs';
import * as storeProductTools from '../src/lib/admin/store-products.mjs';

const originalPreviewEmails = process.env.ENERTEC_PREVIEW_EMAILS;
process.env.ENERTEC_PREVIEW_EMAILS = 'preview.one@example.test,preview.two@example.test';
after(() => {
  if (originalPreviewEmails === undefined) delete process.env.ENERTEC_PREVIEW_EMAILS;
  else process.env.ENERTEC_PREVIEW_EMAILS = originalPreviewEmails;
});

// Execute the real server modules at mocked authentication/database boundaries.
// An unexpected dependency or network request fails the test.
function evaluate(file, dependencies) {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const loadedModule = { exports: {} };
  new Function('require', 'module', 'exports', 'fetch', compiled)(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, loadedModule, loadedModule.exports, () => { throw new Error('Network access is forbidden'); });
  return loadedModule.exports;
}

const preview = { id: 1, sku: '612-ENG', name: 'Enertec preview battery', supplier: 'enertec',
  category: 'Batteries', price: 100, image_url: '', stock_on_hand: null,
  details: { fixedDealerPrice: true, recommendedRetailExVat: 100, distributorCostExVat: 80 } };
const ordinary = { ...preview, id: 2, sku: 'EXISTING', supplier: 'renogy', details: { recommendedRetailExVat: 200 } };
const relations = { loadSkuSuccessions: async () => [], replacementContext: () => ({ replacedBy: [] }) };

test('server allowlist normalizes and deduplicates valid emails, and missing configuration fails closed', () => {
  const configured = process.env.ENERTEC_PREVIEW_EMAILS;
  try {
    process.env.ENERTEC_PREVIEW_EMAILS = ' PREVIEW.ONE@EXAMPLE.TEST ,preview.one@example.test,invalid, ,preview.two@example.test';
    assert.deepEqual(access.enertecPreviewEmails(), ['preview.one@example.test', 'preview.two@example.test']);
    for (const value of [undefined, '', ' , invalid, @example.test, missing@host']) {
      if (value === undefined) delete process.env.ENERTEC_PREVIEW_EMAILS;
      else process.env.ENERTEC_PREVIEW_EMAILS = value;
      assert.deepEqual(access.enertecPreviewEmails(), []);
      assert.equal(access.isProductVisibleTo(preview, 'preview.one@example.test'), false);
    }
  } finally {
    process.env.ENERTEC_PREVIEW_EMAILS = configured;
  }
});

function catalogueHarness(rows = [preview, ordinary]) {
  const queries = [];
  const pool = { query: async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('contact_supplier_discounts')) return { rows: [] };
    if (sql.includes('portal_cart_lines')) return { rows: [{ product_id: 1, quantity: 1 }] };
    if (sql.includes('WHERE id = $1')) return { rows: rows.filter(row => row.id === params[0]) };
    return { rows };
  } };
  const catalogue = evaluate('lib/catalogue.ts', {
    'node:fs': { existsSync: () => false }, 'node:path': { join: (...parts) => parts.join('/') },
    '@/lib/db': pool, '@/lib/catalogue-access.mjs': access,
    '@/lib/catalogue-filters.mjs': { catalogueDerivedDetails: row => ({ catalogueClassification: { category: row.category }, catalogueAttributes: {} }) },
    '@/lib/data-freshness.mjs': { localStockObservation: () => ({ quantity: null }), supplierStockObservation: () => ({ quantity: null }) },
    '@/lib/sku-successions.mjs': relations,
    '@/lib/catalogue-succession.mjs': { isSupersededForDiscovery: () => false, withSuccessionDetails: row => row },
  });
  return { catalogue, pool, queries };
}

test('Enertec preview accepts only the two exact normalized email identities', () => {
  for (const email of ['preview.one@example.test', ' PREVIEW.TWO@EXAMPLE.TEST ']) assert.equal(access.isProductVisibleTo(preview, email), true);
  for (const email of [undefined, '', 'admin@example.test', 'buyer@example.test', 'preview.one+alias@example.test', 'preview.one@example.test.evil.test']) {
    assert.equal(access.isProductVisibleTo(preview, email), false);
  }
  assert.equal(access.isProductVisibleTo(ordinary), true);
  assert.equal(access.isCatalogueRestricted(preview), true);
  assert.equal(access.isCatalogueRestricted(ordinary), false);
});

test('per-product visibility fails closed and cannot broaden the supplier preview', () => {
  for (const catalogueVisibility of [null, {}, { allowedEmails: [] }, { allowedEmails: 'preview.one@example.test' }]) {
    assert.equal(access.isProductVisibleTo({ ...preview, details: { catalogueVisibility } }, 'preview.one@example.test'), false);
  }
  const restricted = { ...preview, details: { catalogueVisibility: { allowedEmails: ['other@example.test', 'PREVIEW.ONE@EXAMPLE.TEST'] } } };
  assert.equal(access.isProductVisibleTo(restricted, 'other@example.test'), false);
  assert.equal(access.isProductVisibleTo(restricted, 'preview.one@example.test'), true);
  assert.equal(access.isProductVisibleTo(restricted, 'preview.two@example.test'), false);
});

test('the actual catalogue excludes preview products before presentation, including historical-cart mode', async () => {
  const { catalogue } = catalogueHarness([preview, ordinary, { ...preview, id: 3, details: { hidden: true } }]);
  for (const userEmail of [undefined, 'other@example.test']) {
    assert.deepEqual((await catalogue.currentCatalogue({}, { userEmail, includeSuperseded: true })).map(row => row.id), [2]);
  }
  assert.deepEqual((await catalogue.currentCatalogue({}, { userEmail: 'preview.one@example.test' })).map(row => row.id), [1, 2]);
});

test('preview selling prices are fixed, unpriced products stay unpriced, and private cost metadata is omitted', () => {
  const { catalogue } = catalogueHarness();
  const presented = catalogue.presentProduct(preview, { enertec: 40 });
  assert.equal(presented.your_price_ex_vat, 100);
  assert.equal(presented.b2b_discount_percent, 0);
  assert.equal(presented.details.distributorCostExVat, undefined);
  const unpriced = catalogue.presentProduct({ ...preview, details: { ...preview.details, pricingStatus: 'unpriced' } }, {});
  assert.equal(unpriced.recommended_retail_ex_vat, null);
  assert.equal(unpriced.your_price_ex_vat, null);
  assert.equal(catalogue.presentProduct(ordinary, {}).your_price_ex_vat, 140);
});

test('product detail returns 404 for other admins and respects the impersonated buyer email', async () => {
  for (const user of [
    { email: 'other@example.test', role: 'admin' },
    { email: 'other@example.test', role: 'buyer', impersonatedBy: { email: 'preview.one@example.test' } },
    { email: 'preview.one@example.test', role: 'buyer' },
  ]) {
    const route = evaluate('app/api/products/[id]/route.ts', {
      '@/lib/auth/server': { currentUser: async () => user }, '@/lib/db': { query: async () => ({ rows: [preview] }) },
      '@/lib/product-details.mjs': { productDetails: row => ({ description: row.name }) },
      '@/lib/catalogue-classification.mjs': { isStorefrontProduct: () => true }, '@/lib/catalogue-access.mjs': access,
      '@/lib/sku-successions.mjs': relations, '@/lib/catalogue-succession.mjs': { withSuccessionDetails: row => row },
    });
    const response = await route.GET(new Request('https://store.example.test/api/products/1'), { params: Promise.resolve({ id: '1' }) });
    assert.equal(response.status, user.email === 'preview.one@example.test' ? 200 : 404);
  }
});

test('guessing a preview product ID cannot add it to another buyer cart', async () => {
  for (const email of ['other@example.test', 'preview.one@example.test']) {
    const h = catalogueHarness();
    const fulfilment = evaluate('lib/victron-fulfilment.ts', { '@/lib/db': h.pool, '@/lib/sku-successions.mjs': { ...relations, productHasStock: () => false }, '@/lib/catalogue-access.mjs': access });
    const route = evaluate('app/api/cart/route.ts', {
      'next/server': { NextResponse: Response }, '@/lib/db': h.pool, '@/lib/catalogue': h.catalogue,
      '@/lib/auth/server': { currentUser: async () => ({ id: 7, email, discounts: {} }) }, '@/lib/victron-fulfilment': fulfilment,
    });
    const request = new Request('https://store.example.test/api/cart', { method: 'POST', body: JSON.stringify({ productId: 1, quantity: 1 }) });
    const response = await route.POST(request);
    assert.equal(response.status, email === 'preview.one@example.test' ? 200 : 404);
    const writes = h.queries.filter(({ sql }) => sql.includes('INSERT INTO portal_cart_lines'));
    assert.equal(writes.length, email === 'preview.one@example.test' ? 1 : 0);
    const cart = await (await route.GET()).json();
    assert.equal(cart.lines.length, email === 'preview.one@example.test' ? 1 : 0);
  }
});

test('search and favourites use the effective buyer and never create public preview thumbnails', async () => {
  for (const email of ['other@example.test', 'preview.one@example.test']) {
    const h = catalogueHarness([{ ...preview, image_url: 'https://enertec.co.za/preview.jpg' }, ordinary]);
    const user = { id: 7, email, discounts: {}, impersonatedBy: { email: 'preview.one@example.test' } };
    const base = { '@/lib/db': h.pool, '@/lib/catalogue': h.catalogue, 'next/server': { NextResponse: Response }, '@/lib/auth/server': { currentUser: async () => user } };
    const search = evaluate('app/api/products/route.ts', {
      ...base, 'node:child_process': { spawn: () => { throw new Error('Preview images must not be written to public/'); } },
      'node:path': { join: (...parts) => parts.join('/') }, '@/lib/catalogue-access.mjs': access,
      '@/lib/catalogue-succession.mjs': { catalogueProductMatchesQuery: (product, query) => product.sku.toLowerCase().includes(query) },
    });
    const searchResponse = await search.GET(new Request('https://store.example.test/api/products?query=612-eng'));
    assert.equal(searchResponse.headers.get('cache-control'), 'private, no-store');
    assert.equal(searchResponse.headers.get('vary'), 'Cookie');
    const searchResults = await searchResponse.json();
    assert.equal(searchResults.length, email === 'preview.one@example.test' ? 1 : 0);
    const favourites = evaluate('app/api/favourites/route.ts', {
      ...base, '@/lib/sku-successions.mjs': relations, '@/lib/favourite-products.mjs': { rankedFavouriteProducts: (_history, products) => products },
    });
    const favouriteResults = await (await favourites.GET()).json();
    assert.equal(favouriteResults.thanda.some(product => product.supplier === 'enertec'), email === 'preview.one@example.test');
  }
});

test('quote-copy previews cannot recover a restricted product from company quote history', async () => {
  for (const email of ['other@example.test', 'preview.two@example.test']) {
    const h = catalogueHarness();
    const user = { id: 7, email, discounts: {}, xeroContactId: 'shared-company' };
    const route = evaluate('app/api/account/quotes/[quoteId]/copy/route.ts', {
      'next/server': { NextResponse: Response }, '@/lib/auth/server': { currentUser: async () => user },
      '@/lib/catalogue': h.catalogue, '@/lib/db': h.pool,
      '@/lib/sku-successions.mjs': { ...relations, normalizeSku: (_supplier, sku) => sku.toUpperCase(), successorSkus: () => [] },
      '@/lib/victron-fulfilment': {}, '@/lib/xero/oauth': {}, '@/lib/commerce/quote-requests.mjs': {},
      '@/lib/quote-settings': {}, '@/lib/commerce/quote-line.mjs': {},
      '@/lib/xero/customer-accounts': { auditAccountAction: async () => {}, customerDocument: async () => ({ payload: {
        Contact: { ContactID: user.xeroContactId }, QuoteNumber: 'Q-1', LineItems: [{ ItemCode: preview.sku, Quantity: 1 }],
      } }) },
    });
    const result = await (await route.GET(new Request('https://store.example.test/api/account/quotes/Q-1/copy'), { params: Promise.resolve({ quoteId: 'Q-1' }) })).json();
    assert.equal(result.lines.length, email === 'preview.two@example.test' ? 1 : 0);
  }
});

test('CSV and JSON exports filter by user identity even when both buyers share a company', async () => {
  const h = catalogueHarness();
  const { catalogueExport } = evaluate('lib/commerce/catalogue-api.ts', {
    '@/lib/db': h.pool, '@/lib/catalogue': h.catalogue, '@/lib/catalogue-classification.mjs': { isStorefrontProduct: () => true },
    './catalogue-export.mjs': exportTools, '@/lib/sku-successions.mjs': relations,
  });
  for (const email of ['other@example.test', 'preview.two@example.test']) {
    const response = await catalogueExport(new Request('https://store.example.test/api/v1/products'), 'same-company', email);
    const data = await response.json();
    assert.equal(data.data.some(row => row.supplier === 'enertec'), email === 'preview.two@example.test');
    const csv = await catalogueExport(new Request('https://store.example.test/api/account/catalogue.csv?format=csv'), 'same-company', email);
    assert.equal((await csv.text()).includes('612-ENG'), email === 'preview.two@example.test');
  }
});

test('API-key export uses its owning user email rather than company-wide visibility', async () => {
  let received;
  const route = evaluate('app/api/v1/products/route.ts', {
    '@/lib/db': { query: async () => ({ rows: [] }) }, '@/lib/auth/schema': { ensureAuthSchema: async () => {} },
    '@/lib/commerce/api-keys.mjs': { authenticateApiKey: async () => ({ id: 'key', user_id: 7, contact_id: 'company', email: 'preview.two@example.test' }), consumeApiRate: async () => true },
    '@/lib/commerce/catalogue-api': { catalogueExport: async (...args) => { received = args; return Response.json({ ok: true }); } },
  });
  assert.equal((await route.GET(new Request('https://store.example.test/api/v1/products'))).status, 200);
  assert.equal(received[1], 'company');
  assert.equal(received[2], 'preview.two@example.test');
});

test('protected image and datasheet reads authorize before returning bytes or an ETag match', async () => {
  for (const file of ['store-product-images', 'store-product-datasheets']) {
    for (const email of [undefined, 'other@example.test', 'preview.one@example.test']) {
      const route = evaluate(`app/api/${file}/[id]/route.ts`, {
        '@/lib/db': { query: async () => ({ rows: [{ ...preview, revision: 'v1', image: Buffer.from('image'), document: Buffer.from('pdf') }] }) },
        '@/lib/auth/server': { currentUser: async () => email ? { email, role: 'admin' } : null }, '@/lib/catalogue-access.mjs': access,
      });
      const response = await route.GET(new Request(`https://store.example.test/api/${file}/1`, { headers: { 'if-none-match': '"v1"' } }), { params: Promise.resolve({ id: '1' }) });
      assert.equal(response.status, email === 'preview.one@example.test' ? 304 : !email && file === 'store-product-datasheets' ? 401 : 404);
      if (email === 'preview.one@example.test') assert.match(response.headers.get('cache-control'), /private, no-store/);
    }
  }
});

test('thumbnail HTTP route does not read restricted files for an unauthorized buyer', async () => {
  let reads = 0;
  const route = evaluate('app/api/product-images/[supplier]/[sku]/route.ts', {
    'node:fs/promises': { readFile: async () => { reads += 1; return Buffer.from('image'); } }, 'node:path': { join: (...parts) => parts.join('/') },
    'next/server': { NextResponse: Response }, '@/lib/auth/server': { currentUser: async () => ({ email: 'other@example.test', role: 'admin' }) },
    '@/lib/catalogue-access.mjs': access,
  });
  const response = await route.GET(new Request('https://store.example.test/api/product-images/enertec/612-ENG'), { params: Promise.resolve({ supplier: 'enertec', sku: '612-ENG' }) });
  assert.equal(response.status, 404);
  assert.equal(reads, 0);
});

function adminProductHarness(email, products, items = []) {
  return evaluate('app/api/admin/products/route.ts', {
    'node:crypto': {}, sharp: {}, '@/lib/auth/impersonation-origin.mjs': {}, '@/lib/store-product-datasheet.mjs': {},
    '@/lib/auth/server': { currentUser: async () => ({ email, role: 'admin' }) }, '@/lib/catalogue-access.mjs': access,
    '@/lib/db': { query: async () => ({ rows: products }) },
    '@/lib/admin/store-products.mjs': { ...storeProductTools,
      storedXeroItems: async () => ({ items, observedAt: '2026-01-01T00:00:00Z' }),
      productIndex: async () => ({ products, successions: [] }),
    },
  });
}

test('admin product listing filters restricted store-managed rows without exposing private details', async () => {
  const rows = [preview, ordinary].map(product => ({ ...product, description: product.name,
    datasheet: null, hidden: false, details: { ...product.details, storeManaged: true } }));
  for (const email of ['other@example.test', 'preview.one@example.test']) {
    const route = adminProductHarness(email, rows);
    const response = await route.GET(new Request('https://store.example.test/api/admin/products?source=store'));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.products.some(product => product.id === preview.id), email === 'preview.one@example.test');
    for (const product of result.products) {
      assert.deepEqual(Object.keys(product).sort(), ['category', 'datasheet', 'description', 'hidden', 'id', 'image_url', 'name', 'price', 'sku']);
      assert.equal(Object.hasOwn(product, 'supplier'), false);
      assert.equal(Object.hasOwn(product, 'details'), false);
    }
  }
});

test('admin Xero product search suppresses restricted SKU and linked item matches instead of offering duplicate imports', async () => {
  const products = [{ ...preview, sku: 'TEST-RESTRICTED-ARTICLE', details: { ...preview.details, xeroItemId: 'restricted-item' } }, ordinary];
  const item = (ItemID, Code) => ({ ItemID, Code, Name: 'Synthetic product', IsSold: true, SalesDetails: { UnitPrice: 100 } });
  const items = [item('code-match', products[0].sku), item('restricted-item', 'TEST-RENAMED-ARTICLE'),
    item('ordinary-item', ordinary.sku), item('new-item', 'TEST-NEW-ARTICLE')];
  for (const email of ['other@example.test', 'preview.two@example.test']) {
    const route = adminProductHarness(email, products, items);
    const response = await route.GET(new Request('https://store.example.test/api/admin/products?q=synthetic'));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.total, email === 'preview.two@example.test' ? 4 : 2);
    const restrictedMatches = result.items.filter(product => ['code-match', 'restricted-item'].includes(product.itemId));
    assert.equal(restrictedMatches.length, email === 'preview.two@example.test' ? 2 : 0);
    for (const product of restrictedMatches) assert.equal(product.existing.id, preview.id);
    assert.equal(result.items.find(product => product.itemId === 'ordinary-item').existing.id, ordinary.id);
    assert.equal(result.items.find(product => product.itemId === 'new-item').existing, null);
  }
});
