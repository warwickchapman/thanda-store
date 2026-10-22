import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { prepareEnertecEnrichment, saveEnertecEnrichment, summarizeEnertecEnrichment } from '../src/lib/enertec-enrichment.mjs';
import { datasheetResource } from '../src/lib/store-product-datasheet.mjs';
import { productDetails } from '../src/lib/product-details.mjs';
import { saveEnertecProducts, buildEnertecProducts } from '../src/lib/enertec-catalogue.mjs';
import { testDatasheetPdf } from './fixtures/store-product-pdf.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'enertec-enrichment-test-'));
after(() => fs.rm(directory, { recursive: true, force: true }));
const originalEmails = process.env.ENERTEC_PREVIEW_EMAILS;
process.env.ENERTEC_PREVIEW_EMAILS = 'preview.one@example.test,preview.two@example.test';
after(() => { if (originalEmails === undefined) delete process.env.ENERTEC_PREVIEW_EMAILS; else process.env.ENERTEC_PREVIEW_EMAILS = originalEmails; });
const photo = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).png().toBuffer();
const pdf = testDatasheetPdf();
await fs.writeFile(path.join(directory, 'photo.png'), photo);
await fs.writeFile(path.join(directory, 'sheet.pdf'), pdf);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const row = {
  sku: 'TEST-BATTERY-001', sourceSku: 'TEST-BATTERY-001',
  productUrl: 'https://enertec.co.za/products/synthetic-test.html',
  description: 'Reviewed supplier description.', technicalData: [{ name: 'Nominal voltage', value: '12 V' }],
  publicResources: [{ kind: 'manual', title: 'Synthetic manual', url: 'https://enertec.co.za/downloads/synthetic-manual.pdf' }],
  image: { path: 'photo.png', sourceUrl: 'https://enertec.co.za/images/synthetic-photo.png', sha256: hash(photo) },
  datasheet: { path: 'sheet.pdf', filename: 'Synthetic datasheet.pdf', sourceUrl: 'https://enertec.co.za/downloads/synthetic-sheet.pdf', sha256: hash(pdf) },
};
const manifest = products => ({ version: 1, observedAt: '2026-10-01T08:00:00.000Z', products });

test('approved exact SKU matches validate local assets, normalize photos and retain source provenance', async () => {
  const products = await prepareEnertecEnrichment(manifest([row]), directory);
  const product = products[0];
  assert.deepEqual(summarizeEnertecEnrichment(products), {
    products: 1, descriptions: 1, technicalSpecifications: 1, cachedPhotos: 1, cachedDatasheets: 1, sourceLinks: 2, externalApiCalls: 0,
  });
  assert.equal((await sharp(product.image.bytes).metadata()).format, 'webp');
  assert.equal(product.image.revision, hash(product.image.bytes));
  assert.deepEqual(product.datasheet.document, pdf);
  assert.equal(product.patch.enertecEnrichment.image.sourceSha256, hash(photo));
  assert.equal(product.patch.enertecEnrichment.datasheet.sourceSha256, hash(pdf));
  assert.equal(Object.hasOwn(product.patch, 'supplierCostExVat'), false);
});

test('ambiguous identities, unapproved hosts, changed assets and paths outside the bundle are rejected', async () => {
  for (const changed of [
    { ...row, sourceSku: 'OTHER-SKU' }, { ...row, productUrl: 'https://enertec.co.za.attacker.test/product' },
    { ...row, image: { ...row.image, sourceUrl: 'http://enertec.co.za/photo.png' } },
    { ...row, image: { ...row.image, path: '/etc/passwd' } },
    { ...row, image: { ...row.image, sha256: 'a'.repeat(64) } },
    { ...row, technicalData: [{ name: 'Voltage', value: '' }] },
    { ...row, publicResources: [{ kind: 'script', title: 'Invalid', url: row.productUrl }] },
    { ...row, datasheet: { ...row.datasheet, kind: 'executable' } },
  ]) await assert.rejects(prepareEnertecEnrichment(manifest([changed]), directory));
  await assert.rejects(prepareEnertecEnrichment(manifest([row, row]), directory), /unique SKU/);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'enertec-outside-test-'));
  try {
    await fs.writeFile(path.join(outside, 'outside.png'), photo);
    await fs.symlink(path.join(outside, 'outside.png'), path.join(directory, 'escape.png'));
    await assert.rejects(prepareEnertecEnrichment(manifest([{ ...row, image: { ...row.image, path: 'escape.png' } }]), directory), /outside/);
  } finally { await fs.rm(outside, { recursive: true, force: true }); }
  await fs.writeFile(path.join(directory, 'invalid.png'), '<html>not an image</html>');
  await assert.rejects(prepareEnertecEnrichment(manifest([{ ...row, image: { path: 'invalid.png', sourceUrl: row.image.sourceUrl } }]), directory), /Cached photo/);
});

test('a cached manual retains its document type through preparation, storage and product details', async () => {
  const products = await prepareEnertecEnrichment(manifest([{ ...row, image: undefined,
    datasheet: { ...row.datasheet, kind: 'manual', filename: 'Synthetic installation manual.pdf' },
  }]), directory);
  assert.equal(products[0].datasheet.kind, 'manual');
  assert.equal(products[0].patch.enertecEnrichment.datasheet.kind, 'manual');
  const calls = [];
  await saveEnertecEnrichment({ query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: sql.startsWith('SELECT id,') ? [{ id: 81, sku: row.sku, name: 'Synthetic', category: 'CTEK', supplier: 'enertec', details: { enertecRange: 'ctek' } }] : [] };
  } }, products);
  const details = JSON.parse(calls.find(call => call.sql.startsWith('UPDATE products SET details=')).values[1]);
  assert.equal(details.storeDatasheet.kind, 'manual');
  const links = productDetails({ id: 81, name: 'Synthetic', supplier: 'enertec', category: 'CTEK', details }).links;
  assert.equal(links[0].kind, 'manual');
  assert.equal(links[0].title, 'Synthetic installation manual.pdf');
  assert.match(links[0].url, /^\/api\/store-product-datasheets\/81\?v=[a-f0-9]{64}$/);
});

test('content writes preserve prices, supplier cost, visibility, stock and identity while caching protected media atomically', async () => {
  const products = await prepareEnertecEnrichment(manifest([row]), directory);
  products[0].patch.price = 1;
  products[0].patch.hidden = false;
  products[0].patch.storeManaged = true;
  const existing = { id: 81, sku: row.sku, name: 'Original price-list identity', supplier: 'enertec', category: 'Energizer',
    details: { enertecRange: 'energizer', supplierCostExVat: 70, recommendedRetailExVat: 100, hidden: true, supplierStockStatus: 'unknown', localStockOnHand: null } };
  const calls = [];
  const client = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: sql.startsWith('SELECT id,') ? [existing] : [] }; } };
  await saveEnertecEnrichment(client, products);
  assert.equal(calls[0].sql, 'BEGIN');
  assert.equal(calls.at(-1).sql, 'COMMIT');
  const detailsWrite = calls.find(call => call.sql.startsWith('UPDATE products SET details='));
  const patch = JSON.parse(detailsWrite.values[1]);
  for (const key of ['price', 'supplierCostExVat', 'recommendedRetailExVat', 'hidden', 'supplierStockStatus', 'localStockOnHand', 'storeManaged']) {
    assert.equal(Object.hasOwn(patch, key), false, key);
  }
  assert.equal(patch.description, row.description);
  assert.equal(patch.catalogueClassification.category, 'Energizer');
  assert.equal(patch.storeDatasheet.filename, row.datasheet.filename);
  assert.ok(calls.some(call => call.sql.includes('INSERT INTO store_product_images')));
  assert.ok(calls.some(call => call.sql.includes('INSERT INTO store_product_datasheets')));
  assert.equal(calls.find(call => call.sql.startsWith('UPDATE products SET image_url=')).values[1], `/api/store-product-images/81?v=${products[0].image.revision}`);
  assert.ok(calls.filter(call => call.sql.startsWith('UPDATE products')).every(call => !/\b(price|name|stock_on_hand|sku|category)=/.test(call.sql)));
  const resource = datasheetResource({ ...existing, details: patch });
  assert.equal(resource.url, `/api/store-product-datasheets/81?v=${products[0].datasheet.revision}`);
  assert.equal(productDetails({ ...existing, details: patch }).links[0].url, resource.url);
  assert.equal(datasheetResource({ ...existing, supplier: 'renogy', details: patch }), null);
});

test('missing rows or database errors roll back every asset and content update; missing allowlist cannot write', async () => {
  const products = await prepareEnertecEnrichment(manifest([{ ...row, image: undefined, datasheet: undefined }]), directory);
  const calls = [];
  await assert.rejects(saveEnertecEnrichment({ query: async sql => { calls.push(sql); return { rows: [] }; } }, products), /not found/);
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.ok(!calls.includes('COMMIT'));
  delete process.env.ENERTEC_PREVIEW_EMAILS;
  try { await assert.rejects(saveEnertecEnrichment({ query: () => assert.fail('No write permitted') }, products), /Configure/); }
  finally { process.env.ENERTEC_PREVIEW_EMAILS = 'preview.one@example.test,preview.two@example.test'; }
});

test('a later price-list import retains enriched descriptions, resources, attributes and protected cached images', async () => {
  const product = buildEnertecProducts([{ sku: row.sku, list: 'energizer', name: 'Original price-list identity', brand: 'Synthetic',
    sourceRanges: ['Synthetic'], costExVat: 77, grossMarginPercent: 23, discontinued: false }])[0];
  const existing = { image_url: `/api/store-product-images/81?v=${'a'.repeat(64)}`, details: {
    enertecEnrichment: { observedAt: manifest([]).observedAt }, description: row.description,
    technicalData: row.technicalData, publicResources: row.publicResources,
    catalogueAttributes: { batteryVoltage: ['12 V'] },
  } };
  const calls = [];
  await saveEnertecProducts({ query: async (sql, values) => {
    calls.push({ sql, values }); return { rows: sql.startsWith('SELECT image_url,details') ? [existing] : [] };
  } }, [product]);
  const insert = calls.find(call => call.sql.startsWith('INSERT'));
  assert.equal(insert.values[5], existing.image_url);
  const details = JSON.parse(insert.values[6]);
  assert.equal(details.description, row.description);
  assert.deepEqual(details.publicResources, row.publicResources);
  assert.deepEqual(details.technicalData, row.technicalData);
  assert.deepEqual(details.catalogueAttributes, existing.details.catalogueAttributes);
  assert.equal(details.supplierCostExVat, 77);
  assert.equal(details.recommendedRetailExVat, 100);
});
