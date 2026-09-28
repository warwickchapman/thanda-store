import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import {
  createAccountSetupToken,
  currentUser,
  hashPassword,
} from '@/lib/auth/server';
import { ensureAuthSchema } from '@/lib/auth/schema';
import { sendAccountSetupEmail, sendPasswordResetEmail } from '@/lib/email/resend';
import { getXeroContactDetails, getXeroContactPeople } from '@/lib/xero/oauth';
import { CompanyManagementError, defaultCompanyDiscount, moveUserCompany, updateUserEmail } from '@/lib/admin/company-management.mjs';

async function requireAdmin() {
  const user = await currentUser();
  if (!user || user.role !== 'admin') return null;
  return user;
}

async function requireUserManager() {
  const user = await requireAdmin();
  return user?.canManageUsers ? user : null;
}

function text(value: unknown) {
  return String(value || '').trim();
}

async function sendSetupEmail(user: { id: number; email: string; organisation_id: number }) {
  const token = await createAccountSetupToken({ userId: Number(user.id), email: user.email,
    organisationId: Number(user.organisation_id) });
  if (!token) throw new Error('Account changed before the setup link could be issued. Reload and try again.');
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
      u.can_manage_users,
      u.api_enabled,
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
    LEFT JOIN contact_supplier_discounts d ON d.contact_id = o.xero_contact_id
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

  const defaultDiscount = defaultCompanyDiscount();
  return NextResponse.json({ users: result.rows.map((user) => ({ ...user, discounts: { victron: defaultDiscount, renogy: defaultDiscount, ...user.discounts } })), canManageUsers: admin.canManageUsers });
}

export async function POST(request: Request) {
  const admin = await requireUserManager();
  if (!admin) return NextResponse.json({ error: 'Manage users permission required' }, { status: 403 });
  await ensureAuthSchema();

  const body = await request.json();
  const email = text(body.email).toLowerCase();
  const organisationId = Number(body.organisationId);
  const role = body.role === 'admin' ? 'admin' : 'buyer';
  const canManageUsers = role === 'admin' && body.canManageUsers === true;

  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return NextResponse.json({ error: 'Provide a valid email address.' }, { status: 400 });
  }
  const selectedCompany = role === 'buyer' && Number.isSafeInteger(organisationId)
    ? (await pool.query('SELECT id,xero_contact_id FROM organisations WHERE id=$1', [organisationId])).rows[0]
    : null;
  if (role === 'buyer' && !selectedCompany?.xero_contact_id) {
    return NextResponse.json({ error: 'Select an existing linked company. Create the company first in Companies if needed.' }, { status: 400 });
  }
  let xeroPerson = null;
  if (selectedCompany) {
    try {
      xeroPerson = (await getXeroContactPeople(selectedCompany.xero_contact_id)).find((person) => person.email === email);
    } catch {
      return NextResponse.json({ error: 'Unable to verify the stored Xero people. No user was created. Try again when the Hub is available.' }, { status: 503 });
    }
    if (!xeroPerson) return NextResponse.json({ error: 'The email must belong to an eligible person on the selected company’s Xero contact.' }, { status: 400 });
  }

  const client = await pool.connect();
  let user: { id: number; email: string; organisation_id: number };
  try {
    await client.query('BEGIN');
    const organisation = selectedCompany ? { rows: [{ id: selectedCompany.id }] } : await client.query(
      `WITH existing AS (
        SELECT id FROM organisations WHERE xero_contact_id IS NULL AND name='Thanda staff' ORDER BY id LIMIT 1
      ), inserted AS (
        INSERT INTO organisations(name) SELECT 'Thanda staff' WHERE NOT EXISTS(SELECT 1 FROM existing) RETURNING id
      ) SELECT id FROM existing UNION ALL SELECT id FROM inserted`,
    );
    const unusablePassword = await hashPassword(crypto.randomBytes(32).toString('hex'));
    const insertedUser = await client.query(
      `
        INSERT INTO portal_users (organisation_id, email, password_hash, role, can_manage_users, is_active, xero_person_kind, xero_person_email)
        VALUES ($1, $2, $3, $4, $5, true, $6, $7)
        RETURNING id, email, organisation_id
      `,
      [organisation.rows[0].id, email, unusablePassword, role, canManageUsers,
        xeroPerson?.kind || 'manual', xeroPerson?.email || null],
    );
    user = insertedUser.rows[0];
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
  const admin = await requireUserManager();
  if (!admin) return NextResponse.json({ error: 'Manage users permission required' }, { status: 403 });
  await ensureAuthSchema();

  const body = await request.json();
  const action = text(body.action) || 'linkXero';

  if (action === 'setCompanyDiscounts' || action === 'linkXero') {
    return NextResponse.json({ error: 'Manage company pricing in Companies. To change a person’s company, use Move company; shared Xero links cannot be repointed.' }, { status: 400 });
  }

  if (action === 'setApiAccess') {
    const id = Number(body.userId);
    if (!Number.isSafeInteger(id) || id < 1) return NextResponse.json({ error: 'A valid user is required.' }, { status: 400 });
    const enabled = body.enabled === true;
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const target = await db.query('SELECT u.id,o.xero_contact_id FROM portal_users u JOIN organisations o ON o.id=u.organisation_id WHERE u.id=$1 FOR UPDATE OF u', [id]);
      if (!target.rowCount || (enabled && !target.rows[0].xero_contact_id)) {
        await db.query('ROLLBACK');
        return NextResponse.json({ error: 'API access requires a user linked to a Xero contact.' }, { status: 400 });
      }
      await db.query('UPDATE portal_users SET api_enabled=$2,updated_at=now() WHERE id=$1', [id,enabled]);
      if (!enabled) await db.query('UPDATE portal_api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1', [id]);
      await db.query(`INSERT INTO portal_activity_log(user_id,organisation_id,action,resource_type,resource_id,metadata)
        VALUES($1,$2,'api_access_changed','user',$3,$4::jsonb)`,[admin.id,admin.organisationId,String(id),JSON.stringify({enabled})]);
      await db.query('COMMIT');
    } catch(error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
    return NextResponse.json({ ok: true });
  }

  if (action === 'setAccess') {
    const userId = Number(body.userId);
    const role = body.role === 'admin' ? 'admin' : 'buyer';
    const canManageUsers = role === 'admin' && body.canManageUsers === true;
    if (!Number.isInteger(userId)) {
      return NextResponse.json({ error: 'A valid user is required.' }, { status: 400 });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const target = await client.query(
        'SELECT u.id,u.role,u.can_manage_users,u.is_active,o.xero_contact_id FROM portal_users u JOIN organisations o ON o.id=u.organisation_id WHERE u.id=$1 FOR UPDATE OF u',
        [userId],
      );
      const current = target.rows[0];
      if (!current) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'User not found.' }, { status: 404 });
      }
      if (role === 'buyer' && !current.xero_contact_id) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Move this user to a linked company before changing their access to Buyer.' }, { status: 400 });
      }
      if (current.is_active && current.role === 'admin' && current.can_manage_users && !canManageUsers) {
        const managers = await client.query(
          "SELECT COUNT(*)::int AS count FROM portal_users WHERE is_active = true AND role = 'admin' AND can_manage_users = true",
        );
        if (Number(managers.rows[0]?.count) <= 1) {
          await client.query('ROLLBACK');
          return NextResponse.json({ error: 'Assign Manage users to another active administrator before removing the last user manager.' }, { status: 400 });
        }
      }
      await client.query(
        'UPDATE portal_users SET role = $2, can_manage_users = $3, updated_at = NOW() WHERE id = $1',
        [userId, role, canManageUsers],
      );
      await client.query('COMMIT');
      return NextResponse.json({ ok: true });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  if (action === 'updateEmail' || action === 'moveCompany') {
    try {
      const result = action === 'updateEmail'
        ? await updateUserEmail(pool, { userId: Number(body.userId), email: body.email, actor: admin, getContact: getXeroContactDetails })
        : await moveUserCompany(pool, { userId: Number(body.userId), organisationId: Number(body.organisationId), email: body.email, actor: admin, getContact: getXeroContactDetails });
      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof CompanyManagementError) return NextResponse.json({ error: error.message }, { status: error.status });
      console.error('Could not update company membership:', error);
      return NextResponse.json({ error: 'Unable to complete this change. No changes were saved. Verify that the stored Xero contact is available and try again.' }, { status: 503 });
    }
  }

  if (action === 'setActive') {
    const userId = Number(body.userId);
    const isActive = body.isActive === true;
    if (!Number.isInteger(userId)) return NextResponse.json({ error: 'A valid user is required.' }, { status: 400 });
    if (userId === admin.id && !isActive) {
      return NextResponse.json({ error: 'You cannot disable your own administrator account.' }, { status: 400 });
    }
    const target = await pool.query('SELECT xero_person_kind, role, can_manage_users, is_active FROM portal_users WHERE id = $1', [userId]);
    if (!target.rows[0]) return NextResponse.json({ error: 'User not found.' }, { status: 404 });
    if (!isActive && target.rows[0].is_active && target.rows[0].role === 'admin' && target.rows[0].can_manage_users) {
      const managers = await pool.query(
        "SELECT COUNT(*)::int AS count FROM portal_users WHERE is_active = true AND role = 'admin' AND can_manage_users = true",
      );
      if (Number(managers.rows[0]?.count) <= 1) {
        return NextResponse.json({ error: 'Assign Manage users to another active administrator before disabling the last user manager.' }, { status: 400 });
      }
    }
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
    let portalUser: { id: number; email: string; organisation_id: number };
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
            RETURNING id, email, organisation_id
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
            RETURNING id, email, organisation_id
          `,
          [organisationId, xeroPerson.email, resetPassword, xeroPerson.kind, xeroPerson.email],
        );
        portalUser = inserted.rows[0];

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
      return NextResponse.json({ ok: true, inviteSent: true, userId: portalUser!.id });
    } catch (error) {
      console.error('Enabled Xero person but could not send setup email:', error);
      return NextResponse.json({ ok: true, inviteSent: false, userId: portalUser!.id });
    }
  }

  return NextResponse.json({ error: 'Unknown user action.' }, { status: 400 });
}

export async function PUT(request: Request) {
  const admin = await requireUserManager();
  if (!admin) return NextResponse.json({ error: 'Manage users permission required' }, { status: 403 });
  await ensureAuthSchema();

  const body = await request.json();
  const action = text(body.action) || 'setup';
  const userId = Number(body.userId);
  if (!Number.isInteger(userId)) return NextResponse.json({ error: 'A valid user is required.' }, { status: 400 });

  const result = await pool.query(
    `
      SELECT u.id, u.email, u.role, u.is_active, u.organisation_id, o.xero_contact_id
      FROM portal_users u
      JOIN organisations o ON o.id = u.organisation_id
      WHERE u.id = $1
      LIMIT 1
    `,
    [userId],
  );
  const user = result.rows[0];
  if (!user) return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  if (!user.is_active) return NextResponse.json({ error: 'Enable this account before sending a password link.' }, { status: 400 });
  if (user.role !== 'admin' && !user.xero_contact_id) {
    return NextResponse.json({ error: 'Link this organisation to Xero before sending a password link.' }, { status: 400 });
  }

  if (action === 'passwordReset') {
    const token = await createAccountSetupToken({ userId: Number(user.id), email: user.email,
      organisationId: Number(user.organisation_id) });
    if (!token) return NextResponse.json({ error: 'Account changed before the reset link could be issued. Reload and try again.' }, { status: 409 });
    await sendPasswordResetEmail({ to: user.email, token });
    return NextResponse.json({ ok: true });
  }

  await sendSetupEmail(user);
  return NextResponse.json({ ok: true });
}
