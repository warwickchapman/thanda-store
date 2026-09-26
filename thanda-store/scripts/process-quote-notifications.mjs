import { createPool } from './product-sync-lib.mjs';
import { runNotifications } from '../src/lib/commerce/notifications.mjs';
const pool=createPool();
try { console.log(JSON.stringify(await runNotifications(pool))); }
finally { await pool.end(); }
