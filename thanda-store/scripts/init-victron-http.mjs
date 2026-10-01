// Deployment-only local migration. Does not contact Victron or Xero.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './product-sync-lib.mjs';
import { accountKey, ensureVictronHttpSchema, nextCatalogueRun } from '../src/lib/victron-http.mjs';

const pool = createPool();
try {
  if (!process.env.VICTRON_EORDER_API_KEY) throw new Error('Victron credentials required to identify the existing account scope.');
  await ensureVictronHttpSchema(pool);
  const account = accountKey(process.env.VICTRON_EORDER_API_KEY, process.env.VICTRON_EORDER_API_ROOT || 'https://eorder.victronenergy.com/api/v1');
  const file = process.env.VICTRON_RATE_LIMIT_CACHE_FILE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.victron-rate-limit.json');
  let legacy;
  try { legacy = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const order = (await pool.query('SELECT next_allowed_at FROM victron_order_sync_state WHERE id=true')).rows[0];
  for (const [scope, value] of [['catalogue', legacy?.retryUntil], ['orders', order?.next_allowed_at]]) {
    if (value && new Date(value).getTime() > Date.now()) {
      await pool.query(`INSERT INTO victron_http_state(account,scope,blocked_until) VALUES($1,$2,$3)
        ON CONFLICT(account,scope) DO UPDATE SET blocked_until=GREATEST(victron_http_state.blocked_until,EXCLUDED.blocked_until)`, [account, scope, value]);
      console.log(`${scope}: preserved cooldown until ${new Date(value).toISOString()}`);
    }
  }
  await pool.query(`INSERT INTO victron_catalogue_schedule(id,last_attempt_at,next_scheduled_at)
    SELECT true,last_started_at,$1 FROM data_sync_status WHERE source_id='victron'
    ON CONFLICT(id) DO NOTHING`, [nextCatalogueRun()]);
  console.log('Victron request tables initialised; no provider calls made.');
} finally { await pool.end(); }
