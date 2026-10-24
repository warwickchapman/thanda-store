import { createPool } from './product-sync-lib.mjs';
import { runNotificationQueues } from '../src/lib/commerce/notifications.mjs';
const pool=createPool();
try {
  console.log(JSON.stringify(await runNotificationQueues(pool)));
}
finally { await pool.end(); }
