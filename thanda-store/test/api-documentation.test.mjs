import assert from 'node:assert/strict';
import test from 'node:test';
import { apiGuideMarkdown, exampleProduct, openApiDocument, productProperties } from '../src/lib/commerce/api-documentation.mjs';
import { catalogueCsv, paginateCatalogue } from '../src/lib/commerce/catalogue-export.mjs';

test('documented product fields match the CSV contract and nullable examples', () => {
  assert.deepEqual(catalogueCsv([]).trim().split(','), Object.keys(productProperties));
  assert.deepEqual(Object.keys(exampleProduct), Object.keys(productProperties));
  for (const [field, value] of Object.entries(exampleProduct)) {
    assert.ok([productProperties[field].type].flat().includes(value === null ? 'null' : typeof value), field);
  }
});

test('documented pagination limits and response fields match the exporter', () => {
  const operation = openApiDocument.paths['/api/v1/products'].get;
  const limit = operation.parameters.find(p => p.name === 'limit').schema;
  for (const count of [limit.minimum, limit.maximum, limit.default]) {
    const result = paginateCatalogue([exampleProduct], 'example-company', new URL(`https://example.test?limit=${count}`));
    for (const field of openApiDocument.components.schemas.CataloguePage.required) assert.ok(field in result);
  }
  assert.throws(() => paginateCatalogue([], 'example', new URL(`https://example.test?limit=${limit.maximum + 1}`)));
  assert.throws(() => paginateCatalogue([], 'example', new URL(`https://example.test?limit=${limit.minimum - 1}`)));
  assert.equal(operation.responses['304'].content, undefined);
  assert.equal(operation.responses['429'].headers['Retry-After'].schema.example, 60);
});

test('LLM download describes only the authenticated read operation with resolvable references', () => {
  assert.deepEqual(Object.keys(openApiDocument.paths), ['/api/v1/products']);
  assert.deepEqual(Object.keys(openApiDocument.paths['/api/v1/products']), ['get']);
  assert.equal(openApiDocument.components.securitySchemes.CustomerApiKey.scheme, 'bearer');
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      let target = openApiDocument;
      for (const segment of value.$ref.slice(2).split('/')) target = target?.[segment];
      assert.ok(target, value.$ref);
    }
    Object.values(value).forEach(walk);
  };
  walk(openApiDocument);
  const markdown = apiGuideMarkdown();
  assert.ok(markdown.includes('$THANDA_API_KEY'));
  assert.ok(markdown.includes('Do not apply the discount again'));
  assert.ok(markdown.includes('After a complete successful scan'));
  assert.doesNotMatch(JSON.stringify(openApiDocument), /ts_[A-Za-z0-9_-]{43}/);
});
