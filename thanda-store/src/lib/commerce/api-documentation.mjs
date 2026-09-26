// Customer documentation is static: no account data, credentials or external reads.
export const apiBaseUrl = 'https://store.thanda.solar';
export const docsVersion = '2026-09-26';
const timestamp = description => ({ type: ['string', 'null'], format: 'date-time', description });
export const productProperties = {
  supplier: { type: 'string', description: 'Supplier identifier. Use supplier and sku together as the product key.' },
  sku: { type: 'string', description: 'Article code. Preserve as a string, including leading zeros and suffixes.' },
  description: { type: 'string', description: 'Catalogue product name; not a full technical description.' },
  price_ex_vat: { type: ['number', 'null'], description: 'Your company’s discounted unit price excluding VAT. Null means no price is available; never treat it as zero.' },
  currency: { type: 'string', description: 'Currency code for the price, normally ZAR.' },
  thanda_stock: { type: ['number', 'null'], description: 'Last recorded Thanda stock on this SKU. Null means unknown, not zero. This is not a reservation or delivery promise.' },
  supplier_stock: { type: ['number', 'null'], description: 'Last recorded supplier stock on this SKU. Null means unknown or not applicable; LoRa has no supplier stock. Kept separate from Thanda stock.' },
  successor_sku: { type: ['string', 'null'], description: 'Explicit immediate replacement article code, where recorded. Null means none is recorded. Do not merge prices or stock with this SKU automatically.' },
  updated_at: timestamp('Local catalogue row update time. This alone does not prove that every stock or price source was refreshed.'),
  supplier_updated_at: timestamp('When supplier catalogue data was last observed; null if not recorded.'),
  thanda_stock_updated_at: timestamp('When the Thanda stock source was last observed; null if not recorded.'),
  pricing_updated_at: timestamp('When the company discount for this supplier was last updated; null if no company-specific discount row exists.'),
};
export const exampleProduct = {
  supplier: 'victron', sku: 'EXAMPLE-SKU', description: 'Example product (illustrative only)',
  price_ex_vat: 1250.5, currency: 'ZAR', thanda_stock: 2, supplier_stock: 12,
  successor_sku: null, updated_at: '2026-09-26T06:00:00.000Z',
  supplier_updated_at: '2026-09-26T05:30:00.000Z', thanda_stock_updated_at: null,
  pricing_updated_at: '2026-09-25T12:00:00.000Z',
};
export const exampleResponse = { revision: 'illustrative-revision', total: 1, data: [exampleProduct], next_cursor: null };
export const curlExample = `# Set THANDA_API_KEY securely in your environment first.
curl --fail-with-body --silent --show-error \\
  --header "Authorization: Bearer $THANDA_API_KEY" \\
  '${apiBaseUrl}/api/v1/products?limit=100'`;
export const csvExample = `curl --fail-with-body --silent --show-error \\
  --header "Authorization: Bearer $THANDA_API_KEY" \\
  '${apiBaseUrl}/api/v1/products?format=csv' \\
  --output thanda-catalogue.csv`;
export const guideSections = [
  { title: 'Get connected', paragraphs: [
    'Ask Thanda to enable API access for your portal user. In API access, give a key a name, choose Generate key, and copy it once. You can keep up to three active keys and revoke them at any time.',
    'The API reads catalogue prices and stock only. It cannot create orders, quotes, invoices or payments. Prices use the discount of your linked Xero company/contact, shared by everyone in that company.',
    'Keep the key in your server’s secret store or environment as THANDA_API_KEY. Send it only in the Authorization: Bearer header over HTTPS. Do not put it in a URL, browser JavaScript, source control or an LLM conversation. Give your assistant these documentation files and configure the real key separately.',
    'A key stops working if it is revoked, API access is disabled, the user becomes inactive or the user is linked to another company. Re-enabling API access does not restore revoked keys.',
  ] },
  { title: 'Read the catalogue', paragraphs: [
    'Use GET /api/v1/products. Responses default to JSON with 100 products per page; limit accepts integers from 1 to 250. Use format=csv for the complete catalogue in one response. Send the same bearer header for either format.',
    'JSON includes revision (the company-specific catalogue fingerprint), total (all products in the current response scope), data (this page), and next_cursor (the opaque next-page token, or null when finished). Products are ordered by supplier, then SKU.',
    'Pass next_cursor back as the cursor query parameter, URL-encoded by your HTTP library. Keep the same key and limit throughout a scan. Do not decode, edit or reuse a cursor for another company. There is no search, changed-since or stock-only parameter in v1.',
  ] },
  { title: 'Keep your integration up to date', paragraphs: [
    'Read every page before publishing a replacement catalogue in your system. If a page returns 409, discard that incomplete scan and restart from page one: catalogue or company pricing changed while paging. Limit automatic restarts, then retry later if the catalogue keeps changing.',
    'After a complete successful scan, save the first page’s ETag, including its quotes, with the same company, URL and limit. On the next check, send it in If-None-Match on that first-page request. A 304 has no body and means that catalogue revision is unchanged. A 200 starts a fresh complete scan; do not send the first page’s ETag on later pages.',
    'For CSV, store that CSV response’s own ETag and use it when checking the same CSV URL again. ETags for JSON pages and CSV are not interchangeable. The X-Catalogue-Revision response header identifies the full company-specific revision.',
    'The limit is 60 requests per minute per user, shared across all their keys and both output formats. Conditional requests count too. On 429, wait for Retry-After before trying again. Schedule checks to suit your business; avoid continuous polling. For network errors or 5xx responses, retry at most three times with increasing delays, then keep your last complete snapshot and report the failure.',
  ] },
  { title: 'Understand prices, stock and CSV', paragraphs: [
    'Prices exclude VAT and already include your company’s discount. Do not apply the discount again. A zero value is a recorded value; null is unknown or not applicable. Stock is last recorded evidence, not a live availability guarantee. Check the source timestamps for freshness.',
    'Use supplier plus sku to match products. A successor_sku is a replacement reference, not permission to combine stock or substitute prices. Your integration controls any updates to your own accounting or stock system.',
    'CSV uses the same fields and company prices as JSON, with a header row and blank cells for null values. Use a CSV parser: text is quoted and embedded quotes are doubled. Cells starting with spreadsheet formula characters are prefixed with an apostrophe for safety. JSON is preferable when your integration needs exact original text.',
  ] },
];
export const responseStatuses = [
  { code: '200', meaning: 'Success', action: 'Parse JSON or CSV according to the requested format.' },
  { code: '304', meaning: 'Unchanged', action: 'No body. Keep the last complete snapshot associated with this ETag.' },
  { code: '400', meaning: 'Invalid request', action: 'Check limit and cursor. Read the JSON error message; correct the request before retrying.' },
  { code: '401', meaning: 'Key not accepted', action: 'Check the bearer header, key revocation, API access and company linking. Do not keep retrying the same invalid key.' },
  { code: '409', meaning: 'Catalogue changed', action: 'Discard the partial scan and restart from the first page, with a bounded number of restarts.' },
  { code: '429', meaning: 'Rate limit reached', action: 'Wait for the Retry-After header (seconds) before retrying.' },
  { code: '5xx', meaning: 'Temporary server failure', action: 'The body may not be JSON. Retry with bounded backoff; retain the last complete snapshot.' },
];
const errorContent = { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } };
const revisionHeader = { description: 'Fingerprint of the full catalogue and company pricing.', schema: { type: 'string' } };
const etagHeader = { description: 'Opaque validator for this exact representation. Preserve quotes and associate with the same URL/company.', schema: { type: 'string' } };
export const openApiDocument = {
  openapi: '3.1.1',
  info: { title: 'Thanda Store customer catalogue API', version: '1.0.0', description: 'Read-only company pricing excluding VAT and separate stock sources. API documentation revision: '+docsVersion+'. Examples are illustrative, not live prices or credentials.' },
  servers: [{ url: apiBaseUrl }],
  security: [{ CustomerApiKey: [] }],
  'x-integration-guide': guideSections,
  'x-documentation-updated': docsVersion,
  paths: {
    '/api/v1/products': {
      get: {
        operationId: 'getCustomerCatalogue', summary: 'Read your company’s catalogue prices and stock',
        description: 'Returns paginated JSON, or the complete CSV with format=csv. Data is read from the stored catalogue, without a live source refresh. Only the parameters below are supported. This API has no write operations.',
        'x-codeSamples': [{ lang: 'Shell', source: curlExample }, { lang: 'Shell', label: 'Complete CSV', source: csvExample }],
        parameters: [
          { name: 'limit', in: 'query', description: 'JSON page size. Keep constant while paging. Validation also applies to CSV, although CSV returns all rows.', schema: { type: 'integer', minimum: 1, maximum: 250, default: 100 } },
          { name: 'cursor', in: 'query', description: 'Opaque next_cursor from the previous JSON page. Omit on the first page and for a fresh CSV export.', schema: { type: 'string' } },
          { name: 'format', in: 'query', description: 'Omit for JSON; use csv for a complete CSV download.', schema: { type: 'string', enum: ['json', 'csv'], default: 'json' } },
          { name: 'If-None-Match', in: 'header', description: 'Previously saved ETag for the same URL and company. Only save a first-page ETag after completing the entire scan.', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Catalogue page or complete CSV.', headers: { ETag: etagHeader, 'X-Catalogue-Revision': revisionHeader }, content: {
            'application/json': { schema: { $ref: '#/components/schemas/CataloguePage' }, example: exampleResponse },
            'text/csv': { schema: { type: 'string' }, example: Object.keys(productProperties).join(',')+'\r\n' },
          } },
          '304': { description: 'Unchanged representation. No response body.', headers: { ETag: etagHeader, 'X-Catalogue-Revision': revisionHeader } },
          '400': { description: 'Invalid limit or cursor.', content: errorContent },
          '401': { description: 'Missing, invalid, revoked or disabled key, inactive user, or changed company link.', content: errorContent },
          '409': { description: 'Catalogue revision changed. Restart pagination.', headers: { 'X-Catalogue-Revision': revisionHeader }, content: errorContent },
          '429': { description: '60 requests per minute per user across all keys.', headers: { 'Retry-After': { description: 'Seconds to wait before retrying.', schema: { type: 'integer', example: 60 } } }, content: errorContent },
          '5XX': { description: 'Server failure. Response body is not guaranteed to be JSON. Use bounded retries.' },
        },
      },
    },
  },
  components: {
    securitySchemes: { CustomerApiKey: { type: 'http', scheme: 'bearer', description: 'A key generated by the enabled portal user. Static secret, not a JWT. Configure securely outside the documentation or LLM prompt.' } },
    schemas: {
      Product: { type: 'object', required: Object.keys(productProperties), properties: productProperties },
      CataloguePage: { type: 'object', required: ['revision', 'total', 'data', 'next_cursor'], properties: {
        revision: { type: 'string', description: 'Full catalogue fingerprint scoped to this company.' }, total: { type: 'integer', minimum: 0 },
        data: { type: 'array', items: { $ref: '#/components/schemas/Product' } }, next_cursor: { type: ['string', 'null'], description: 'Pass as cursor to fetch the next page; null marks the end.' },
      } },
      Error: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } },
    },
  },
};
export function apiGuideMarkdown() {
  return [
    '# Thanda Store API guide', `Documentation updated: ${docsVersion}. API v1.`,
    ...guideSections.flatMap(s => [`## ${s.title}`, ...s.paragraphs]),
    '## First request', '```sh\n'+curlExample+'\n```',
    '## Example JSON response (illustrative only)', '```json\n'+JSON.stringify(exampleResponse, null, 2)+'\n```',
    '## Product fields', '| Field | Type | Meaning |\n| --- | --- | --- |\n'+Object.entries(productProperties).map(([name,s])=>`| ${name} | ${[].concat(s.type).join(' or ')} | ${s.description} |`).join('\n'),
    '## Complete CSV download', '```sh\n'+csvExample+'\n```',
    '## Responses', ...responseStatuses.map(s=>`- **${s.code} ${s.meaning}:** ${s.action}`),
  ].join('\n\n')+'\n';
}
