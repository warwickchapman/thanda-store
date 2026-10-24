import { createPool } from './product-sync-lib.mjs';
import { ensurePublicRfqSchema } from '../src/lib/commerce/public-rfq.mjs';

if (!process.argv.includes('--write')) {
  console.log('Plan: create local guest_quote_requests, guest_quote_rate_limits and guest_quote_notifications tables. No provider calls. Run with --write to apply.');
} else {
  const pool = createPool();
  try { await ensurePublicRfqSchema(pool); console.log('Public quote enquiry tables are ready. No email or accounting request was sent.'); }
  finally { await pool.end(); }
}
