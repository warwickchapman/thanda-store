import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { currentUser } from '@/lib/auth/server';
import { ensureAuthSchema } from '@/lib/auth/schema';

async function requireAdmin() {
  const user = await currentUser();
  if (!user || user.role !== 'admin') return null;
  return user;
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
      o.id AS organisation_id,
      o.name AS organisation_name,
      o.xero_contact_id,
      o.xero_contact_name,
      COALESCE(jsonb_object_agg(d.supplier, d.discount_percent) FILTER (WHERE d.supplier IS NOT NULL), '{}'::jsonb) AS discounts
    FROM portal_users u
    JOIN organisations o ON o.id = u.organisation_id
    LEFT JOIN user_supplier_discounts d ON d.user_id = u.id
    GROUP BY u.id, o.id
    ORDER BY o.name, u.username
  `);

  return NextResponse.json({ users: result.rows });
}

export async function PATCH(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  await ensureAuthSchema();

  const body = await request.json();
  const organisationId = Number(body.organisationId);
  const xeroContactId = String(body.xeroContactId || '').trim();
  const xeroContactName = String(body.xeroContactName || '').trim();

  if (!Number.isFinite(organisationId) || !xeroContactId || !xeroContactName) {
    return NextResponse.json({ error: 'Organisation, Xero contact ID, and name are required' }, { status: 400 });
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
