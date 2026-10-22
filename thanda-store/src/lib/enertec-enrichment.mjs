import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { enertecPreviewEmails } from './catalogue-access.mjs';
import { catalogueDerivedDetails } from './catalogue-filters.mjs';
import { ensureStoreProductSchema } from './admin/store-products.mjs';
import { publicManufacturerUrl } from './product-details.mjs';
import { MAX_PRODUCT_UPLOAD_BYTES, validateDatasheet } from './store-product-datasheet.mjs';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const boundedText = (value, max) => typeof value === 'string' && value.trim() && value.length <= max
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) ? value.trim() : null;

function sourceUrl(value, productOnly = false) {
  const result = publicManufacturerUrl(value, 'enertec');
  if (!result || (productOnly && new URL(result).hostname !== 'enertec.co.za')) {
    throw new Error('An approved HTTPS manufacturer source URL is required.');
  }
  return result;
}

async function readAsset(asset, rootDirectory) {
  if (!asset || typeof asset.path !== 'string' || !asset.path || path.isAbsolute(asset.path)) {
    throw new Error('Asset paths must be relative to the enrichment manifest.');
  }
  const root = await fs.realpath(rootDirectory);
  const filename = await fs.realpath(path.resolve(root, asset.path));
  const relative = path.relative(root, filename);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Asset path is outside the enrichment directory.');
  }
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_PRODUCT_UPLOAD_BYTES) throw new Error('Cached assets must be files up to 8 MB.');
  const bytes = await fs.readFile(filename);
  if (bytes.length > MAX_PRODUCT_UPLOAD_BYTES) throw new Error('Cached assets must be files up to 8 MB.');
  const sha256 = digest(bytes);
  if (asset.sha256 !== undefined && asset.sha256 !== sha256) throw new Error('Cached asset checksum does not match the approved manifest.');
  return { bytes, sha256, sourceUrl: sourceUrl(asset.sourceUrl), filename: path.basename(filename) };
}

// Imports only locally mined, explicitly reviewed matches. No network or Xero calls.
export async function prepareEnertecEnrichment(manifest, rootDirectory) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.products) || !manifest.products.length
    || manifest.products.length > 1000 || typeof manifest.observedAt !== 'string'
    || !Number.isFinite(Date.parse(manifest.observedAt))) throw new Error('A version 1 enrichment manifest with an observation time is required.');
  const seen = new Set();
  const products = [];
  for (const row of manifest.products) {
    const sku = boundedText(row?.sku, 100);
    if (!sku || !/^[A-Z0-9][A-Z0-9/.-]+$/.test(sku) || seen.has(sku)
      || typeof row.sourceSku !== 'string' || row.sourceSku.trim().toUpperCase() !== sku) {
      throw new Error('Each enrichment requires a unique SKU matching the displayed website stock code.');
    }
    seen.add(sku);
    const productUrl = sourceUrl(row.productUrl, true);
    const patch = {};
    if (row.description !== undefined) {
      const description = boundedText(row.description, 20000);
      if (!description) throw new Error(`Invalid enrichment description: ${sku}`);
      patch.description = description;
    }
    if (row.technicalData !== undefined) {
      if (!Array.isArray(row.technicalData) || row.technicalData.length > 100) throw new Error(`Invalid technical data: ${sku}`);
      patch.technicalData = row.technicalData.map(spec => {
        const name = boundedText(spec?.name, 200);
        const value = boundedText(typeof spec?.value === 'number' ? String(spec.value) : spec?.value, 2000);
        if (!name || !value) throw new Error(`Invalid technical data: ${sku}`);
        return { name, value };
      });
    }
    const resources = [{ kind: 'product', title: 'Enertec product page', url: productUrl }];
    if (row.publicResources !== undefined) {
      if (!Array.isArray(row.publicResources) || row.publicResources.length > 29) throw new Error(`Invalid resources: ${sku}`);
      for (const resource of row.publicResources) {
        if (!['product', 'datasheet', 'manual'].includes(resource?.kind)) throw new Error(`Invalid resource type: ${sku}`);
        const title = boundedText(resource.title, 250);
        if (!title) throw new Error(`Invalid resource title: ${sku}`);
        const url = sourceUrl(resource.url);
        if (!resources.some(existing => existing.url === url)) resources.push({ kind: resource.kind, title, url });
      }
    }
    patch.publicResources = resources;
    const provenance = { observedAt: new Date(manifest.observedAt).toISOString(), sourceSku: row.sourceSku.trim(), productUrl };
    let image;
    if (row.image) {
      const asset = await readAsset(row.image, rootDirectory);
      try {
        const decoder = sharp(asset.bytes, { limitInputPixels: 25_000_000, failOn: 'error' });
        const metadata = await decoder.metadata();
        if (!['jpeg', 'png', 'webp'].includes(metadata.format || '') || (metadata.pages || 1) > 1) throw new Error('Unsupported photo');
        const bytes = await decoder.rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
        image = { bytes, revision: digest(bytes) };
      } catch { throw new Error(`Cached photo must be JPG, PNG or WebP, up to 25 megapixels: ${sku}`); }
      provenance.image = { sourceUrl: asset.sourceUrl, sourceSha256: asset.sha256, revision: image.revision };
    }
    let datasheet;
    if (row.datasheet) {
      if (row.datasheet.kind !== undefined && !['datasheet', 'manual'].includes(row.datasheet.kind)) throw new Error(`Invalid cached document kind: ${sku}`);
      const asset = await readAsset(row.datasheet, rootDirectory);
      datasheet = await validateDatasheet(asset.bytes, row.datasheet.filename || asset.filename);
      datasheet.kind = row.datasheet.kind || 'datasheet';
      provenance.datasheet = { kind: datasheet.kind, sourceUrl: asset.sourceUrl, sourceSha256: asset.sha256, revision: datasheet.revision };
    }
    patch.enertecEnrichment = provenance;
    products.push({ sku, patch, image, datasheet });
  }
  return products;
}

export function summarizeEnertecEnrichment(products) {
  return {
    products: products.length, descriptions: products.filter(product => product.patch.description).length,
    technicalSpecifications: products.filter(product => product.patch.technicalData?.length).length,
    cachedPhotos: products.filter(product => product.image).length,
    cachedDatasheets: products.filter(product => product.datasheet).length,
    sourceLinks: products.reduce((total, product) => total + product.patch.publicResources.length, 0),
    externalApiCalls: 0,
  };
}

export async function saveEnertecEnrichment(client, products) {
  if (!enertecPreviewEmails().length) throw new Error('Configure ENERTEC_PREVIEW_EMAILS before enriching preview products.');
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('enertec-catalogue-seed'))");
    await ensureStoreProductSchema(client);
    for (const product of products) {
      const result = await client.query("SELECT id,sku,name,category,supplier,details FROM products WHERE supplier='enertec' AND sku=$1 FOR UPDATE", [product.sku]);
      if (result.rows.length !== 1) throw new Error(`Existing Enertec product not found: ${product.sku}`);
      const existing = result.rows[0];
      // Whitelist content fields again at the write boundary. A manifest cannot change
      // pricing, buying costs, stock, identity, visibility or storeManaged behaviour.
      const details = { ...existing.details };
      for (const key of ['description', 'technicalData', 'publicResources']) {
        if (Object.hasOwn(product.patch, key)) details[key] = product.patch[key];
      }
      details.enertecEnrichment = { ...existing.details?.enertecEnrichment, ...product.patch.enertecEnrichment };
      if (product.datasheet) details.storeDatasheet = { kind: product.datasheet.kind || 'datasheet', filename: product.datasheet.filename, revision: product.datasheet.revision };
      const derived = catalogueDerivedDetails({ ...existing, details });
      const contentPatch = { ...derived, enertecEnrichment: details.enertecEnrichment };
      for (const key of ['description', 'technicalData', 'publicResources', 'storeDatasheet']) {
        if (Object.hasOwn(details, key)) contentPatch[key] = details[key];
      }
      if (product.image) {
        await client.query(`INSERT INTO store_product_images(product_id,image,revision) VALUES($1,$2,$3)
          ON CONFLICT(product_id) DO UPDATE SET image=EXCLUDED.image,revision=EXCLUDED.revision`,
        [existing.id, product.image.bytes, product.image.revision]);
        await client.query("UPDATE products SET image_url=$2 WHERE id=$1 AND supplier='enertec'", [existing.id, `/api/store-product-images/${existing.id}?v=${product.image.revision}`]);
      }
      if (product.datasheet) {
        await client.query(`INSERT INTO store_product_datasheets(product_id,document,filename,revision) VALUES($1,$2,$3,$4)
          ON CONFLICT(product_id) DO UPDATE SET document=EXCLUDED.document,filename=EXCLUDED.filename,revision=EXCLUDED.revision`,
        [existing.id, product.datasheet.document, product.datasheet.filename, product.datasheet.revision]);
      }
      await client.query("UPDATE products SET details=details || $2::jsonb,last_updated=NOW() WHERE id=$1 AND supplier='enertec'", [existing.id, JSON.stringify(contentPatch)]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
