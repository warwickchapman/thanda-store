import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDatasheet, datasheetResource, MAX_PRODUCT_UPLOAD_BYTES } from '../src/lib/store-product-datasheet.mjs';
import { productDetails } from '../src/lib/product-details.mjs';
import { testDatasheetPdf } from './fixtures/store-product-pdf.mjs';

test('valid PDFs retain their bytes, use a bounded safe display filename and revision', async () => {
  const pdf = testDatasheetPdf();
  const sheet = await validateDatasheet(pdf, '../folder/Example\u0000 datasheet.PDF');
  assert.deepEqual(sheet.document, pdf);
  assert.equal(sheet.filename, 'Example datasheet.pdf');
  assert.match(sheet.revision, /^[a-f0-9]{64}$/);
  assert.equal((await validateDatasheet(testDatasheetPdf('replacement'), 'new.pdf')).revision === sheet.revision, false);
});

test('renamed non-PDF files, unreadable PDFs, empty files and oversized uploads are rejected', async () => {
  await assert.rejects(() => validateDatasheet(Buffer.from('<html>not a PDF</html>'), 'sheet.pdf'), /valid PDF/);
  await assert.rejects(() => validateDatasheet(Buffer.from('%PDF-1.7\nnot a readable PDF'), 'sheet.pdf'), /readable PDF/);
  await assert.rejects(() => validateDatasheet(Buffer.alloc(0), 'sheet.pdf'), /up to 8 MB/);
  await assert.rejects(() => validateDatasheet(Buffer.alloc(MAX_PRODUCT_UPLOAD_BYTES + 1), 'sheet.pdf'), /up to 8 MB/);
});

test('customer details expose only a server-generated datasheet URL and preserve manufacturer links', () => {
  const product = { id: 12, name: 'Example', supplier: 'thanda', category: 'Other products', details: {
    storeManaged: true, storeDatasheet: { filename: 'Example datasheet.pdf', revision: 'a'.repeat(64), url: 'https://untrusted.test/document' },
  } };
  const resource = datasheetResource(product);
  assert.equal(resource.url, `/api/store-product-datasheets/12?v=${'a'.repeat(64)}`);
  assert.deepEqual(productDetails(product).links, [resource]);
  assert.equal(datasheetResource({ ...product, id: '../private' }), null);
  assert.equal(datasheetResource({ ...product, details: { ...product.details, storeDatasheet: { revision: '../private', filename: 'a.pdf' } } }), null);
  const manufacturer = { ...product, supplier: 'victron', details: { publicResources: [{ kind: 'datasheet', title: 'Victron sheet', url: 'https://www.victronenergy.com/upload/example.pdf' }] } };
  assert.deepEqual(productDetails(manufacturer).links, [{ kind: 'datasheet', title: 'Victron sheet', url: 'https://www.victronenergy.com/upload/example.pdf' }]);
});
