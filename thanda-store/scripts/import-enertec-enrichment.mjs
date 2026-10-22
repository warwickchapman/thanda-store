import fs from 'node:fs/promises';
import path from 'node:path';
import { createPool } from './product-sync-lib.mjs';
import { prepareEnertecEnrichment, saveEnertecEnrichment, summarizeEnertecEnrichment } from '../src/lib/enertec-enrichment.mjs';

const args = process.argv.slice(2);
const filename = process.env.ENERTEC_ENRICHMENT_FILE;
if (!filename || args.some(arg => !['--write', '--dry-run'].includes(arg)) || (args.includes('--write') && args.includes('--dry-run'))) {
  throw new Error('Set ENERTEC_ENRICHMENT_FILE to a private manifest, then run import-enertec-enrichment.mjs [--dry-run | --write].');
}
const manifest = JSON.parse(await fs.readFile(filename, 'utf8'));
const products = await prepareEnertecEnrichment(manifest, path.dirname(path.resolve(filename)));
const write = args.includes('--write');
if (write) {
  const pool = createPool();
  const client = await pool.connect();
  try { await saveEnertecEnrichment(client, products); }
  finally { client.release(); await pool.end(); }
}
console.log(JSON.stringify({ mode: write ? 'written' : 'dry-run', ...summarizeEnertecEnrichment(products) }, null, 2));
