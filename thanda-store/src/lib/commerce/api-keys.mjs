import crypto from 'node:crypto';
export const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
export function newApiKey() {
  const token = `ts_${crypto.randomBytes(32).toString('base64url')}`;
  return { id: crypto.randomUUID(), token, hash: tokenHash(token), prefix: token.slice(0, 11) };
}
export class ApiKeyIssuanceError extends Error {}

export async function issueApiKey(pool, { user, name, sessionToken }) {
  if (!sessionToken) throw new ApiKeyIssuanceError('Sign in again before creating a key.');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows } = await db.query(`SELECT u.email,u.organisation_id,u.api_enabled,u.is_active,u.archived_at,o.xero_contact_id
      FROM portal_users u JOIN organisations o ON o.id=u.organisation_id WHERE u.id=$1 FOR UPDATE OF u`, [user.id]);
    const owner = rows[0];
    if (!owner?.api_enabled || !owner.is_active || owner.archived_at
      || owner.email.toLowerCase() !== user.email.toLowerCase()
      || Number(owner.organisation_id) !== user.organisationId || owner.xero_contact_id !== user.xeroContactId) {
      throw new ApiKeyIssuanceError('Your account changed. Sign in again before creating a key.');
    }
    // Check the actual session after taking the same user lock as an identity
    // change; otherwise an already-authenticated request can mint a new key
    // after that change revoked its credentials.
    const session = await db.query('SELECT 1 FROM portal_sessions WHERE user_id=$1 AND session_hash=$2 AND expires_at>now()',
      [user.id, tokenHash(sessionToken)]);
    if (!session.rowCount) throw new ApiKeyIssuanceError('Your session ended. Sign in again before creating a key.');
    const count = await db.query('SELECT count(*)::int AS n FROM portal_api_keys WHERE user_id=$1 AND revoked_at IS NULL', [user.id]);
    if (count.rows[0].n >= 3) throw new ApiKeyIssuanceError('Revoke an existing key before creating another (maximum three).');
    const key = newApiKey();
    await db.query('INSERT INTO portal_api_keys(id,user_id,contact_id,name,token_hash,prefix) VALUES($1,$2,$3,$4,$5,$6)',
      [key.id,user.id,user.xeroContactId,name,key.hash,key.prefix]);
    await db.query('COMMIT');
    return { id: key.id, token: key.token };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
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
