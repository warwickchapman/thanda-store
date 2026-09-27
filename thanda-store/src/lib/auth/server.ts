import { cookies } from 'next/headers';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import pool from '@/lib/db';
import { ensureAuthSchema } from './schema';
import { finishAccountSetup, finishLogin, issueAccountSetupToken, issueLoginOtp } from './login.mjs';

export const SESSION_COOKIE = 'thanda_session';

export type PortalUser = {
  id: number;
  email: string;
  role: string;
  canManageUsers: boolean;
  apiEnabled: boolean;
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

export async function createAccountSetupToken(expected: LoginIdentity) {
  await ensureAuthSchema();
  return issueAccountSetupToken(pool, expected);
}

export async function completeAccountSetup(token: string, password: string) {
  await ensureAuthSchema();
  return finishAccountSetup(pool, token, () => hashPassword(password));
}

type LoginIdentity = { userId: number; email: string; organisationId: number };

export async function createLoginOtp(expected: LoginIdentity & { passwordHash: string }) {
  return issueLoginOtp(pool, expected);
}

export async function completeLogin(expected: LoginIdentity, otp: string) {
  return finishLogin(pool, expected, otp);
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
        u.can_manage_users,
        u.api_enabled,
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
    'SELECT supplier, discount_percent FROM contact_supplier_discounts WHERE contact_id = $1',
    [row.xero_contact_id],
  );
  const discounts: Record<string, number> = {};
  for (const discount of discountsResult.rows) {
    discounts[String(discount.supplier).toLowerCase()] = Math.min(40, Math.max(0, numberOrZero(discount.discount_percent)));
  }

  return {
    id: Number(row.id),
    email: row.email,
    role: row.role,
    canManageUsers: Boolean(row.can_manage_users),
    apiEnabled: Boolean(row.api_enabled),
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
