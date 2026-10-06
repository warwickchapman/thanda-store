import { createPool } from './product-sync-lib.mjs';
import { refreshReview } from '../src/lib/victron-catalogue-service.mjs';
const pool = createPool();
try {
  const result = await refreshReview(pool);
  console.log(JSON.stringify({ checked: true, changes: result.rows.length, observedAt: result.observedAt }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await pool.end(); }
