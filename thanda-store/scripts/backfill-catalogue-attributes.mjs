#!/usr/bin/env node
import { isDeepStrictEqual } from 'node:util';
import { createPool } from './product-sync-lib.mjs';
import { catalogueDerivedDetails } from '../src/lib/catalogue-filters.mjs';

// PostgreSQL only. Bounded, restartable batches; dry-run unless --write is given.
const write = process.argv.includes('--write');
const pool = createPool();
let after = '0';
let scanned = 0;
let changed = 0;
try {
  while (true) {
    const { rows } = await pool.query('SELECT id, supplier, name, category, details FROM products WHERE id > $1 ORDER BY id LIMIT 250', [after]);
    if (!rows.length) break;
    for (const row of rows) {
      const patch = catalogueDerivedDetails(row);
      if (Object.entries(patch).some(([key, value]) => !isDeepStrictEqual(row.details[key], value))) {
        changed++;
        if (write) {
          // Do not overwrite a concurrent sync or stock update; the next run
          // will pick up any skipped record using its latest source data.
          await pool.query(`UPDATE products SET details = details || $2::jsonb
            WHERE id = $1 AND details = $3::jsonb AND name = $4 AND category = $5`,
          [row.id, JSON.stringify(patch), JSON.stringify(row.details), row.name, row.category]);
        }
      }
      scanned++;
      after = row.id;
    }
  }
  console.log(`${write ? 'Backfill' : 'Dry run'}: ${scanned} products inspected; ${changed} attribute records ${write ? 'eligible for update' : 'would change'}. No external requests.`);
} finally {
  await pool.end();
}
