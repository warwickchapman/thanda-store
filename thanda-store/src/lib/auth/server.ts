import { cookies } from 'next/headers';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import pool from '@/lib/db';
import { ensureAuthSchema } from './schema';

export const SESSION_COOKIE = 'thanda_session';
const OTP_TTL_MINUTES = 10;
const SESSION_TTL_DAYS = 14;
const MAX_OTP_ATTEMPTS = 5;
const ACCOUNT_SETUP_TTL_DAYS = 7;

export type PortalUser = {
  id: number;
  email: string;
  role: string;
  organisationId: number;
  organisationName: string;
  xeroContactId: string | null;
  xeroContactName: string | null;
  discounts: Record<string, number>;
};

function sha256(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

function numericCode(length = 6) {
  const max = 10 ** length;
  return String(crypto.randomInt(0, max)).padStart(length, '0');
}

function numberOrZero(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function findLoginUser(email: string) {
  await ensureAuthSchema();
  const result = await pool.query(
    `
      SELECT u.*, o.name AS organisation_name, o.xero_contact_id, o.xero_contact_name
      FROM portal_users u
      JOIN organisations o ON o.id = u.organisation_id
      WHERE lower(u.email) = lower($1) AND u.is_active = true
      LIMIT 1
    `,
    [email.trim()],
  );
  return result.rows[0] || null;
}

export async function verifyPassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash);
}

export async function createAccountSetupToken(userId: number) {
  await ensureAuthSchema();
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `
      UPDATE account_setup_tokens
      SET consumed_at = NOW()
      WHERE user_id = $1 AND consumed_at IS NULL
    `,
    [userId],
  );
  await pool.query(
    `
      INSERT INTO account_setup_tokens (user_id, token_hash, expires_at)
      VALUES ($1, $2, NOW() + ($3::text || ' days')::interval)
    `,
    [userId, sha256(token), ACCOUNT_SETUP_TTL_DAYS],
  );
  return token;
}

export async function completeAccountSetup(token: string, password: string) {
  await ensureAuthSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tokenResult = await client.query(
      `
        SELECT user_id
        FROM account_setup_tokens
        WHERE token_hash = $1
          AND consumed_at IS NULL
          AND expires_at > NOW()
        FOR UPDATE
      `,
      [sha256(token)],
    );
    const row = tokenResult.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return false;
    }

    const passwordHash = await hashPassword(password);
    await client.query(
      'UPDATE portal_users SET password_hash = $2, updated_at = NOW() WHERE id = $1',
      [row.user_id, passwordHash],
    );
    await client.query(
      'UPDATE account_setup_tokens SET consumed_at = NOW() WHERE token_hash = $1',
      [sha256(token)],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createLoginOtp(userId: number) {
  const otp = numericCode();
  await pool.query(
    `
      INSERT INTO login_otps (user_id, otp_hash, expires_at)
      VALUES ($1, $2, NOW() + ($3::text || ' minutes')::interval)
    `,
    [userId, sha256(otp), OTP_TTL_MINUTES],
  );
  return otp;
}

export async function consumeLoginOtp(userId: number, otp: string) {
  const result = await pool.query(
    `
      SELECT id, otp_hash, attempts
      FROM login_otps
      WHERE user_id = $1
        AND consumed_at IS NULL
        AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return false;

  if (row.attempts >= MAX_OTP_ATTEMPTS) return false;

  const matches = row.otp_hash === sha256(otp.trim());
  if (!matches) {
    await pool.query('UPDATE login_otps SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    return false;
  }

  await pool.query('UPDATE login_otps SET consumed_at = NOW() WHERE id = $1', [row.id]);
  return true;
}

export async function createSession(userId: number) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `
      INSERT INTO portal_sessions (user_id, session_hash, expires_at)
      VALUES ($1, $2, NOW() + ($3::text || ' days')::interval)
    `,
    [userId, sha256(token), SESSION_TTL_DAYS],
  );
  return token;
}

export async function destroySession(token: string | undefined) {
  if (!token) return;
  await ensureAuthSchema();
  await pool.query('DELETE FROM portal_sessions WHERE session_hash = $1', [sha256(token)]);
}

export async function currentUserFromToken(token: string | undefined): Promise<PortalUser | null> {
  if (!token) return null;
  await ensureAuthSchema();
  const result = await pool.query(
    `
      SELECT
        u.id,
        u.email,
        u.role,
        o.id AS organisation_id,
        o.name AS organisation_name,
        o.xero_contact_id,
        o.xero_contact_name
      FROM portal_sessions s
      JOIN portal_users u ON u.id = s.user_id
      JOIN organisations o ON o.id = u.organisation_id
      WHERE s.session_hash = $1
        AND s.expires_at > NOW()
        AND u.is_active = true
      LIMIT 1
    `,
    [sha256(token)],
  );
  const row = result.rows[0];
  if (!row) return null;

  await pool.query('UPDATE portal_sessions SET last_seen_at = NOW() WHERE session_hash = $1', [sha256(token)]);

  const discountsResult = await pool.query(
    'SELECT supplier, discount_percent FROM user_supplier_discounts WHERE user_id = $1',
    [row.id],
  );
  const discounts: Record<string, number> = {};
  for (const discount of discountsResult.rows) {
    discounts[String(discount.supplier).toLowerCase()] = Math.min(40, Math.max(0, numberOrZero(discount.discount_percent)));
  }

  return {
    id: Number(row.id),
    email: row.email,
    role: row.role,
    organisationId: Number(row.organisation_id),
    organisationName: row.organisation_name,
    xeroContactId: row.xero_contact_id,
    xeroContactName: row.xero_contact_name,
    discounts,
  };
}

export async function currentUser() {
  const cookieStore = await cookies();
  return currentUserFromToken(cookieStore.get(SESSION_COOKIE)?.value);
}

export function canLogin(user: { role: string; xero_contact_id?: string | null }) {
  return user.role === 'admin' || Boolean(user.xero_contact_id);
}
