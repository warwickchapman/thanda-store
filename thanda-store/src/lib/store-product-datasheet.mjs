import crypto from 'node:crypto';

export const MAX_PRODUCT_UPLOAD_BYTES = 8 * 1024 * 1024;

export function datasheetResource(product) {
  const sheet = product.details?.storeDatasheet;
  const id = Number(product.id);
  if (product.details?.storeManaged !== true || !Number.isSafeInteger(id) || id < 1
    || !sheet || typeof sheet.filename !== 'string' || !/^[a-f0-9]{64}$/.test(sheet.revision)) return null;
  return { kind: 'datasheet', title: sheet.filename, url: `/api/store-product-datasheets/${id}?v=${sheet.revision}` };
}

export async function validateDatasheet(bytes, originalFilename) {
  if (!bytes.length || bytes.length > MAX_PRODUCT_UPLOAD_BYTES) throw new Error('Choose a PDF datasheet up to 8 MB.');
  if (!/^%PDF-\d\.\d/.test(Buffer.from(bytes).subarray(0, 8).toString('ascii'))) throw new Error('Choose a valid PDF datasheet.');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Supply the existing PDF.js worker directly so packaged Next.js routes do
  // not try to resolve a worker file relative to a generated server chunk.
  globalThis.pdfjsWorker ||= await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 });
  try {
    const pdf = await task.promise;
    if (pdf.numPages < 1) throw new Error('Empty PDF');
  } catch {
    throw new Error('Choose a readable PDF datasheet without password protection.');
  } finally { await task.destroy(); }
  const name = String(originalFilename || 'Datasheet.pdf').split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\.pdf$/i, '').slice(0, 180) || 'Datasheet';
  return { document: Buffer.from(bytes), filename: `${name}.pdf`, revision: crypto.createHash('sha256').update(bytes).digest('hex') };
}
