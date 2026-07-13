import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import {
  createAccountSetupToken,
  currentUser,
  hashPassword,
} from '@/lib/auth/server';
import { ensureAuthSchema } from '@/lib/auth/schema';
import { sendAccountSetupEmail } from '@/lib/email/resend';

const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,64}$/;

async function requireAdmin() {
  const user = await currentUser();
  if (!user || user.role !== 'admin') return null;
  return user;
}

function text(value: unknown) {
  return String(value || '').trim();
}

function discount(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 40 ? parsed : null;
}

async function sendSetupEmail(user: { id: number; username: string; email: string }) {
  const token = await createAccountSetupToken(user.id);
  await sendAccountSetupEmail({ to: user.email, username: user.username, token });
}

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  await ensureAuthSchema();

  const result = await pool.query(`
    SELECT
      u.id,
      u.username,
      u.email,
      u.role,
      u.is_active,
      o.id AS organisation_id,
      o.name AS organisation_name,
      o.xero_contact_id,
      o.xero_contact_name,
      invite.expires_at AS setup_expires_at,
      COALESCE(jsonb_object_agg(d.supplier, d.discount_percent) FILTER (WHERE d.supplier IS NOT NULL), '{}'::jsonb) AS discounts
    FROM portal_users u
    JOIN organisations o ON o.id = u.organisation_id
    LEFT JOIN user_supplier_discounts d ON d.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT expires_at
      FROM account_setup_tokens
      WHERE user_id = u.id
        AND consumed_at IS NULL
        AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1
    ) invite ON true
    GROUP BY u.id, o.id, invite.expires_at
    ORDER BY o.name, u.username
  `);

  return NextResponse.json({ users: result.rows });
}

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  await ensureAuthSchema();

  const body = await request.json();
  const organisationName = text(body.organisationName);
  const username = text(body.username);
  const email = text(body.email).toLowerCase();
  const xeroContactId = text(body.xeroContactId);
  const xeroContactName = text(body.xeroContactName);
  const victronDiscount = discount(body.victronDiscount);
  const renogyDiscount = discount(body.renogyDiscount);

  if (!organisationName || !USERNAME_PATTERN.test(username) || !/^\S+@\S+\.\S+$/.test(email)) {
    return NextResponse.json({ error: 'Provide a company, a valid username, and an email address.' }, { status: 400 });
  }
  if (!xeroContactId || !xeroContactName) {
    return NextResponse.json({ error: 'Link the company to a Xero contact before inviting a user.' }, { status: 400 });
  }
  if (victronDiscount === null || renogyDiscount === null) {
    return NextResponse.json({ error: 'Victron and Renogy discounts must be between 0% and 40%.' }, { status: 400 });
  }

  const client = await pool.connect();
  let user: { id: number; username: string; email: string };
  try {
    await client.query('BEGIN');
    const organisation = await client.query(
      `
        INSERT INTO organisations (name, xero_contact_id, xero_contact_name)
        VALUES ($1, $2, $3)
        ON CONFLICT (name) DO UPDATE
          SET xero_contact_id = EXCLUDED.xero_contact_id,
              xero_contact_name = EXCLUDED.xero_contact_name,
              updated_at = NOW()
        RETURNING id
      `,
      [organisationName, xeroContactId, xeroContactName],
    );
    const unusablePassword = await hashPassword(crypto.randomBytes(32).toString('hex'));
    const insertedUser = await client.query(
      `
        INSERT INTO portal_users (organisation_id, username, email, password_hash, role, is_active)
        VALUES ($1, $2, $3, $4, 'buyer', true)
        RETURNING id, username, email
      `,
      [organisation.rows[0].id, username, email, unusablePassword],
    );
    user = insertedUser.rows[0];
    await client.query(
      `
        INSERT INTO user_supplier_discounts (user_id, supplier, discount_percent)
        VALUES ($1, 'victron', $2), ($1, 'renogy', $3)
      `,
      [user.id, victronDiscount, renogyDiscount],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json({ error: 'That username already exists.' }, { status: 409 });
    }
    throw error;
  } finally {
    client.release();
  }

  try {
    await sendSetupEmail(user!);
    return NextResponse.json({ ok: true, inviteSent: true }, { status: 201 });
  } catch (error) {
    console.error('Created user but could not send account setup email:', error);
    return NextResponse.json({ ok: true, inviteSent: false }, { status: 202 });
  }
}

export async function PATCH(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  await ensureAuthSchema();

  const body = await request.json();
  const action = text(body.action) || 'linkXero';

  if (action === 'updateEmail') {
    const userId = Number(body.userId);
    const email = text(body.email).toLowerCase();
    if (!Number.isInteger(userId) || !/^\S+@\S+\.\S+$/.test(email)) {
      return NextResponse.json({ error: 'A valid user and email address are required.' }, { status: 400 });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query(
        'SELECT organisation_id, email FROM portal_users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      const row = user.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'User not found.' }, { status: 404 });
      }
      if (row.email.toLowerCase() === email) {
        await client.query('COMMIT');
        return NextResponse.json({ ok: true, unchanged: true, signedOut: false });
      }

      const duplicate = await client.query(
        'SELECT id FROM portal_users WHERE LOWER(email) = $1 AND id <> $2 LIMIT 1',
        [email, userId],
      );
      if (duplicate.rowCount) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'That email address is already assigned to another portal user.' }, { status: 409 });
      }

      await client.query(
        'UPDATE portal_users SET email = $2, updated_at = NOW() WHERE id = $1',
        [userId, email],
      );
      await client.query(
        `
          UPDATE organisations
          SET xero_contact_id = NULL,
              xero_contact_name = NULL,
              updated_at = NOW()
          WHERE id = $1
        `,
        [row.organisation_id],
      );
      await client.query('DELETE FROM portal_sessions WHERE user_id = $1', [userId]);
      await client.query('UPDATE login_otps SET consumed_at = NOW() WHERE user_id = $1 AND consumed_at IS NULL', [userId]);
      await client.query('UPDATE account_setup_tokens SET consumed_at = NOW() WHERE user_id = $1 AND consumed_at IS NULL', [userId]);
      await client.query('COMMIT');
      return NextResponse.json({ ok: true, signedOut: userId === admin.id });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  if (action === 'setActive') {
    const userId = Number(body.userId);
    const isActive = body.isActive === true;
    if (!Number.isInteger(userId)) return NextResponse.json({ error: 'A valid user is required.' }, { status: 400 });
    if (userId === admin.id && !isActive) {
      return NextResponse.json({ error: 'You cannot disable your own administrator account.' }, { status: 400 });
    }
    await pool.query('UPDATE portal_users SET is_active = $2, updated_at = NOW() WHERE id = $1', [userId, isActive]);
    return NextResponse.json({ ok: true });
  }

  const organisationId = Number(body.organisationId);
  const xeroContactId = text(body.xeroContactId);
  const xeroContactName = text(body.xeroContactName);
  if (!Number.isInteger(organisationId) || !xeroContactId || !xeroContactName) {
    return NextResponse.json({ error: 'Organisation, Xero contact ID, and name are required.' }, { status: 400 });
  }

  await pool.query(
    `
      UPDATE organisations
      SET xero_contact_id = $2,
          xero_contact_name = $3,
          updated_at = NOW()
      WHERE id = $1
    `,
    [organisationId, xeroContactId, xeroContactName],
  );
  return NextResponse.json({ ok: true });
}

export async function PUT(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  await ensureAuthSchema();

  const body = await request.json();
  const userId = Number(body.userId);
  if (!Number.isInteger(userId)) return NextResponse.json({ error: 'A valid user is required.' }, { status: 400 });

  const result = await pool.query(
    `
      SELECT u.id, u.username, u.email, o.xero_contact_id
      FROM portal_users u
      JOIN organisations o ON o.id = u.organisation_id
      WHERE u.id = $1
      LIMIT 1
    `,
    [userId],
  );
  const user = result.rows[0];
  if (!user) return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  if (!user.xero_contact_id) {
    return NextResponse.json({ error: 'Link this organisation to Xero before sending setup email.' }, { status: 400 });
  }

  await sendSetupEmail(user);
  return NextResponse.json({ ok: true });
}
