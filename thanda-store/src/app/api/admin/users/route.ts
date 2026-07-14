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
import { getXeroContactDetails, getXeroContactPeople } from '@/lib/xero/oauth';

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

async function sendSetupEmail(user: { id: number; email: string }) {
  const token = await createAccountSetupToken(user.id);
  await sendAccountSetupEmail({ to: user.email, token });
}

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  await ensureAuthSchema();

  const result = await pool.query(`
    SELECT
      u.id,
      u.email,
      u.role,
      u.is_active,
      u.xero_person_kind,
      u.archived_at,
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
    ORDER BY o.name, u.email
  `);

  return NextResponse.json({ users: result.rows });
}

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  await ensureAuthSchema();

  const body = await request.json();
  const email = text(body.email).toLowerCase();
  const xeroContactId = text(body.xeroContactId);
  const victronDiscount = discount(body.victronDiscount);
  const renogyDiscount = discount(body.renogyDiscount);

  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return NextResponse.json({ error: 'Provide a valid email address.' }, { status: 400 });
  }
  if (!xeroContactId) {
    return NextResponse.json({ error: 'Select a Xero contact before inviting a user.' }, { status: 400 });
  }
  if (victronDiscount === null || renogyDiscount === null) {
    return NextResponse.json({ error: 'Victron and Renogy discounts must be between 0% and 40%.' }, { status: 400 });
  }
  const xeroContact = await getXeroContactDetails(xeroContactId);
  const xeroPrimary = xeroContact.people.find(
    (person) => person.kind === 'primary' && person.email === email,
  );
  if (!xeroPrimary) {
    return NextResponse.json({ error: 'The portal email must match the selected Xero contact primary email address.' }, { status: 400 });
  }

  const client = await pool.connect();
  let user: { id: number; email: string };
  try {
    await client.query('BEGIN');
    const organisation = await client.query(
      `
        INSERT INTO organisations (name, xero_contact_id, xero_contact_name)
        VALUES ($1, $2, $3)
        ON CONFLICT (xero_contact_id) WHERE xero_contact_id IS NOT NULL DO UPDATE
          SET name = EXCLUDED.name,
              xero_contact_name = EXCLUDED.xero_contact_name,
              updated_at = NOW()
        RETURNING id
      `,
      [xeroContact.name, xeroContactId, xeroContact.name],
    );
    const unusablePassword = await hashPassword(crypto.randomBytes(32).toString('hex'));
    const insertedUser = await client.query(
      `
        INSERT INTO portal_users (organisation_id, email, password_hash, role, is_active, xero_person_kind, xero_person_email)
        VALUES ($1, $2, $3, 'buyer', true, 'primary', $2)
        RETURNING id, email
      `,
      [organisation.rows[0].id, email, unusablePassword],
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
      return NextResponse.json({ error: 'That email address already exists.' }, { status: 409 });
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
    const target = await pool.query('SELECT xero_person_kind FROM portal_users WHERE id = $1', [userId]);
    if (!target.rows[0]) return NextResponse.json({ error: 'User not found.' }, { status: 404 });
    if (isActive && target.rows[0].xero_person_kind !== 'manual') {
      return NextResponse.json({ error: 'Re-enable Xero-managed users from the Xero people list so their eligibility is verified.' }, { status: 400 });
    }
    await pool.query('UPDATE portal_users SET is_active = $2, archived_at = CASE WHEN $2 THEN NULL ELSE archived_at END, updated_at = NOW() WHERE id = $1', [userId, isActive]);
    return NextResponse.json({ ok: true });
  }

  if (action === 'enableXeroPerson') {
    const organisationId = Number(body.organisationId);
    const email = text(body.email).toLowerCase();
    if (!Number.isInteger(organisationId) || !/^\S+@\S+\.\S+$/.test(email)) {
      return NextResponse.json({ error: 'An organisation and valid Xero person email are required.' }, { status: 400 });
    }

    const organisation = await pool.query(
      'SELECT xero_contact_id FROM organisations WHERE id = $1 LIMIT 1',
      [organisationId],
    );
    const contactId = organisation.rows[0]?.xero_contact_id;
    if (!contactId) return NextResponse.json({ error: 'Link the organisation to Xero first.' }, { status: 400 });

    const xeroPerson = (await getXeroContactPeople(contactId)).find((person) => person.email === email);
    if (!xeroPerson) {
      return NextResponse.json({ error: 'That person is no longer present on the linked Xero contact.' }, { status: 400 });
    }

    const client = await pool.connect();
    let portalUser: { id: number; email: string };
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        'SELECT id, organisation_id FROM portal_users WHERE LOWER(email) = $1 FOR UPDATE',
        [email],
      );
      const existingUser = existing.rows[0];
      if (existingUser && Number(existingUser.organisation_id) !== organisationId) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'This email already belongs to another portal organisation.' }, { status: 409 });
      }

      if (existingUser) {
        const resetPassword = await hashPassword(crypto.randomBytes(32).toString('hex'));
        const updated = await client.query(
          `
            UPDATE portal_users
            SET password_hash = $2,
                is_active = true,
                archived_at = NULL,
                xero_person_kind = $3,
                xero_person_email = $4,
                updated_at = NOW()
            WHERE id = $1
            RETURNING id, email
          `,
          [existingUser.id, resetPassword, xeroPerson.kind, xeroPerson.email],
        );
        portalUser = updated.rows[0];
      } else {
        const resetPassword = await hashPassword(crypto.randomBytes(32).toString('hex'));
        const inserted = await client.query(
          `
            INSERT INTO portal_users (organisation_id, email, password_hash, role, is_active, xero_person_kind, xero_person_email)
            VALUES ($1, $2, $3, 'buyer', true, $4, $5)
            RETURNING id, email
          `,
          [organisationId, xeroPerson.email, resetPassword, xeroPerson.kind, xeroPerson.email],
        );
        portalUser = inserted.rows[0];
        await client.query(
          `
            INSERT INTO user_supplier_discounts (user_id, supplier, discount_percent)
            SELECT $1, supplier, discount_percent
            FROM user_supplier_discounts
            WHERE user_id = (SELECT id FROM portal_users WHERE organisation_id = $2 ORDER BY id LIMIT 1)
            ON CONFLICT (user_id, supplier) DO NOTHING
          `,
          [portalUser.id, organisationId],
        );
      }
      await client.query('DELETE FROM portal_sessions WHERE user_id = $1', [portalUser.id]);
      await client.query('UPDATE login_otps SET consumed_at = NOW() WHERE user_id = $1 AND consumed_at IS NULL', [portalUser.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    try {
      await sendSetupEmail(portalUser!);
      return NextResponse.json({ ok: true, inviteSent: true });
    } catch (error) {
      console.error('Enabled Xero person but could not send setup email:', error);
      return NextResponse.json({ ok: true, inviteSent: false });
    }
  }

  const organisationId = Number(body.organisationId);
  const xeroContactId = text(body.xeroContactId);
  if (!Number.isInteger(organisationId) || !xeroContactId) {
    return NextResponse.json({ error: 'Organisation and Xero contact ID are required.' }, { status: 400 });
  }

  const xeroContact = await getXeroContactDetails(xeroContactId);
  const people = xeroContact.people;
  await pool.query(
    `
      UPDATE organisations
      SET name = $2,
          xero_contact_id = $3,
          xero_contact_name = $2,
          updated_at = NOW()
      WHERE id = $1
    `,
    [organisationId, xeroContact.name, xeroContactId],
  );
  for (const person of people) {
    await pool.query(
      `
        UPDATE portal_users
        SET xero_person_kind = $3,
            xero_person_email = $2,
            archived_at = NULL,
            updated_at = NOW()
        WHERE organisation_id = $1
          AND LOWER(email) = $2
      `,
      [organisationId, person.email, person.kind],
    );
  }
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
      SELECT u.id, u.email, o.xero_contact_id
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
