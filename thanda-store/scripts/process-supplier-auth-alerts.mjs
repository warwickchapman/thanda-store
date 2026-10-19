import { createPool } from './product-sync-lib.mjs';
import { runSupplierAuthNotifications } from '../src/lib/supplier-auth-notifications.mjs';
const pool = createPool();
try { console.log(JSON.stringify(await runSupplierAuthNotifications(pool))); }
finally { await pool.end(); }
