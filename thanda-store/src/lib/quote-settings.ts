import pool from '@/lib/db';
import { ensureAuthSchema } from '@/lib/auth/schema';

export type CustomerQuoteStatus = 'DRAFT' | 'SENT';

export async function customerQuoteStatus(): Promise<CustomerQuoteStatus> {
  await ensureAuthSchema();
  const result = await pool.query<{ drafts_only: boolean }>(
    'SELECT drafts_only FROM portal_quote_settings WHERE id = true',
  );
  return result.rows[0]?.drafts_only === false ? 'SENT' : 'DRAFT';
}

export async function quoteDraftsOnly() {
  return (await customerQuoteStatus()) === 'DRAFT';
}

export async function setQuoteDraftsOnly(draftsOnly: boolean, userId: number) {
  await ensureAuthSchema();
  await pool.query(
    `INSERT INTO portal_quote_settings (id, drafts_only, updated_by_user_id, updated_at)
     VALUES (true, $1, $2, NOW())
     ON CONFLICT (id) DO UPDATE
     SET drafts_only = EXCLUDED.drafts_only,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = NOW()`,
    [draftsOnly, userId],
  );
  return draftsOnly;
}
