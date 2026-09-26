import crypto from 'node:crypto';
export const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
export function newApiKey() {
  const token = `ts_${crypto.randomBytes(32).toString('base64url')}`;
  return { id: crypto.randomUUID(), token, hash: tokenHash(token), prefix: token.slice(0, 11) };
}
export async function authenticateApiKey(pool, authorization) {
  const token = /^Bearer (ts_[A-Za-z0-9_-]{43})$/.exec(authorization || '')?.[1];
  if (!token) return null;
  const result = await pool.query(`SELECT k.id,k.user_id,k.contact_id FROM portal_api_keys k
    JOIN portal_users u ON u.id=k.user_id JOIN organisations o ON o.id=u.organisation_id
    WHERE k.token_hash=$1 AND k.revoked_at IS NULL AND u.is_active AND u.archived_at IS NULL
      AND u.api_enabled AND o.xero_contact_id=k.contact_id`, [tokenHash(token)]);
  return result.rows[0] || null;
}
export async function consumeApiRate(pool, userId) {
  const { rows } = await pool.query(`INSERT INTO portal_api_rate_limits(user_id,window_start,requests)
    VALUES($1,date_trunc('minute',now()),1) ON CONFLICT(user_id) DO UPDATE SET
      window_start=date_trunc('minute',now()),requests=CASE WHEN portal_api_rate_limits.window_start=date_trunc('minute',now())
        THEN portal_api_rate_limits.requests+1 ELSE 1 END RETURNING requests`, [userId]);
  return Number(rows[0].requests) <= 60;
}
