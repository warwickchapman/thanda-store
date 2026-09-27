import crypto from 'node:crypto';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const OTP_TTL_MINUTES = 10;
const SESSION_TTL_DAYS = 14;
const MAX_OTP_ATTEMPTS = 5;
const ACCOUNT_SETUP_TTL_DAYS = 7;

function matchesLoginIdentity(user, expected) {
  return Boolean(user?.is_active && !user.archived_at
    && user.email.toLowerCase() === expected.email.toLowerCase()
    && Number(user.organisation_id) === Number(expected.organisationId)
    && (user.role === 'admin' || user.xero_contact_id));
}

async function withLoginUser(pool, expected, work) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Company/email edits take this same lock before revoking credentials.
    // A request either finishes before that revocation, or rechecks the new
    // identity afterward. It cannot issue credentials from the old identity.
    const { rows } = await db.query(`SELECT u.email,u.organisation_id,u.password_hash,u.role,u.is_active,u.archived_at,o.xero_contact_id
      FROM portal_users u JOIN organisations o ON o.id=u.organisation_id WHERE u.id=$1 FOR UPDATE OF u`, [expected.userId]);
    const result = matchesLoginIdentity(rows[0], expected) ? await work(db, rows[0]) : null;
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}

export async function issueLoginOtp(pool, expected) {
  return withLoginUser(pool, expected, async (db, user) => {
    // Password verification happened before acquiring the lock; a concurrent
    // reset must not let that stale password authorise a new code.
    if (user.password_hash !== expected.passwordHash) return null;
    const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await db.query('UPDATE login_otps SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL', [expected.userId]);
    await db.query(`INSERT INTO login_otps(user_id,otp_hash,expires_at)
      VALUES($1,$2,now()+($3::text || ' minutes')::interval)`, [expected.userId, hash(otp), OTP_TTL_MINUTES]);
    return otp;
  });
}

export async function finishLogin(pool, expected, otp) {
  return withLoginUser(pool, expected, async (db) => {
    const { rows } = await db.query(`SELECT id,otp_hash,attempts FROM login_otps
      WHERE user_id=$1 AND consumed_at IS NULL AND expires_at>now()
      ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`, [expected.userId]);
    const code = rows[0];
    if (!code || code.attempts >= MAX_OTP_ATTEMPTS) return null;
    if (code.otp_hash !== hash(otp.trim())) {
      await db.query('UPDATE login_otps SET attempts=attempts+1 WHERE id=$1', [code.id]);
      return null;
    }
    await db.query('UPDATE login_otps SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL', [expected.userId]);
    const token = crypto.randomBytes(32).toString('hex');
    await db.query(`INSERT INTO portal_sessions(user_id,session_hash,expires_at)
      VALUES($1,$2,now()+($3::text || ' days')::interval)`, [expected.userId, hash(token), SESSION_TTL_DAYS]);
    return token;
  });
}

export async function issueAccountSetupToken(pool, expected) {
  return withLoginUser(pool, expected, async (db) => {
    const token = crypto.randomBytes(32).toString('hex');
    await db.query('UPDATE account_setup_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL', [expected.userId]);
    await db.query(`INSERT INTO account_setup_tokens(user_id,token_hash,expires_at)
      VALUES($1,$2,now()+($3::text || ' days')::interval)`, [expected.userId, hash(token), ACCOUNT_SETUP_TTL_DAYS]);
    return token;
  });
}

export async function finishAccountSetup(pool, token, makePasswordHash) {
  // This first read only identifies the user. Validation and mutation happen
  // after locking that user, in the same user→token order as company edits.
  const { rows } = await pool.query(`SELECT u.id,u.email,u.organisation_id FROM account_setup_tokens t
    JOIN portal_users u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.consumed_at IS NULL AND t.expires_at>now()`, [hash(token)]);
  const user = rows[0];
  if (!user) return null;
  const expected = { userId: Number(user.id), email: user.email, organisationId: Number(user.organisation_id) };
  return withLoginUser(pool, expected, async (db) => {
    const valid = await db.query(`SELECT token_hash FROM account_setup_tokens
      WHERE user_id=$1 AND token_hash=$2 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`, [expected.userId, hash(token)]);
    if (!valid.rowCount) return null;
    await db.query('UPDATE portal_users SET password_hash=$2,updated_at=now() WHERE id=$1', [expected.userId, await makePasswordHash()]);
    await db.query('UPDATE account_setup_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL', [expected.userId]);
    await db.query('UPDATE login_otps SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL', [expected.userId]);
    return expected.email;
  });
}
