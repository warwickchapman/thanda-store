import fs from 'node:fs';
import { enertecPreviewEmails } from '../src/lib/catalogue-access.mjs';
import { createPool } from './product-sync-lib.mjs';
import { buildEnertecProducts, saveEnertecProducts, summarizeEnertecProducts } from '../src/lib/enertec-catalogue.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--write', '--dry-run'].includes(arg)) || (args.includes('--write') && args.includes('--dry-run'))) {
  throw new Error('Usage: node scripts/seed-enertec-products.mjs [--dry-run | --write]');
}
const sourceFile = process.env.ENERTEC_SOURCE_FILE || new URL('../data/enertec-products.json', import.meta.url);
if (!fs.existsSync(sourceFile)) throw new Error('Private Enertec source file not found. Set ENERTEC_SOURCE_FILE.');
const entries = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
const products = buildEnertecProducts(entries);
const write = args.includes('--write');
if (write) {
  if (!enertecPreviewEmails().length) throw new Error('Configure ENERTEC_PREVIEW_EMAILS before importing preview products.');
  const pool = createPool();
  const client = await pool.connect();
  try {
    await saveEnertecProducts(client, products);
  } finally {
    client.release();
    await pool.end();
  }
}
console.log(JSON.stringify({ mode: write ? 'written' : 'dry-run', ...summarizeEnertecProducts(products),
  externalApiCalls: 0, stock: 'Unknown; no supplier or Xero stock lookup was made.' }, null, 2));
