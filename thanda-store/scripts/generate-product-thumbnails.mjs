import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createPool, ensureProductSchema } from './product-sync-lib.mjs';

const THUMBNAIL_SIZE = Number(process.env.PRODUCT_THUMBNAIL_SIZE || 600);
const IMAGE_BOX_SIZE = Number(process.env.PRODUCT_THUMBNAIL_IMAGE_BOX_SIZE || 520);
const QUALITY = Number(process.env.PRODUCT_THUMBNAIL_QUALITY || 80);
const USER_AGENT = 'ThandaStoreThumbnailSync/1.0';

function parseArgs(argv) {
  const args = {
    force: false,
    limit: null,
    supplier: null,
    sku: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force') args.force = true;
    else if (arg === '--limit') args.limit = Number(argv[++index]);
    else if (arg === '--supplier') args.supplier = String(argv[++index] || '').toLowerCase();
    else if (arg === '--sku') args.sku = String(argv[++index] || '');
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }

  return args;
}

function safePathPart(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function thumbnailRelativePath(product) {
  const supplier = safePathPart(product.supplier.toLowerCase()) || 'unknown';
  const sku = safePathPart(product.sku) || String(product.id);
  return `/product-images/${supplier}/${sku}.webp`;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fetchImage(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType && !contentType.toLowerCase().includes('image')) {
    throw new Error(`Unexpected content type: ${contentType}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function writeThumbnail(sourceBuffer, outputPath) {
  const inner = await sharp(sourceBuffer, { animated: false })
    .rotate()
    .resize({
      width: IMAGE_BOX_SIZE,
      height: IMAGE_BOX_SIZE,
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp({
    create: {
      width: THUMBNAIL_SIZE,
      height: THUMBNAIL_SIZE,
      channels: 3,
      background: '#ffffff',
    },
  })
    .composite([{
      input: inner,
      gravity: 'center',
    }])
    .webp({ quality: QUALITY, effort: 5 })
    .toFile(outputPath);
}

async function loadProducts(client, args) {
  const where = ["image_url IS NOT NULL", "image_url <> ''"];
  const params = [];

  if (args.supplier) {
    params.push(args.supplier);
    where.push(`lower(supplier) = $${params.length}`);
  }

  if (args.sku) {
    params.push(args.sku);
    where.push(`sku = $${params.length}`);
  }

  const limitClause = args.limit ? `LIMIT ${args.limit}` : '';
  const result = await client.query(
    `
      SELECT id, supplier, sku, name, image_url
      FROM products
      WHERE ${where.join(' AND ')}
      ORDER BY supplier ASC, sku ASC
      ${limitClause}
    `,
    params,
  );
  return result.rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pool = createPool();
  const client = await pool.connect();
  const stats = {
    checked: 0,
    created: 0,
    skipped: 0,
    failed: 0,
  };

  try {
    await ensureProductSchema(client);
    const products = await loadProducts(client, args);

    for (const product of products) {
      stats.checked += 1;
      const relativePath = thumbnailRelativePath(product);
      const outputPath = path.join(process.cwd(), 'public', relativePath.replace(/^\//, ''));

      if (!args.force && await fileExists(outputPath)) {
        stats.skipped += 1;
        continue;
      }

      try {
        const sourceBuffer = await fetchImage(product.image_url);
        await writeThumbnail(sourceBuffer, outputPath);
        stats.created += 1;
        console.log(`thumbnail ${product.supplier}/${product.sku} -> ${relativePath}`);
      } catch (error) {
        stats.failed += 1;
        console.warn(`failed ${product.supplier}/${product.sku}: ${error.message}`);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log(JSON.stringify(stats, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
