import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { currentUser } from '@/lib/auth/server';
import { ensureAuthSchema } from '@/lib/auth/schema';
import { getXeroContactDetails } from '@/lib/xero/oauth';
import { CompanyManagementError, defaultCompanyDiscount, createCompany, saveCompanyDiscounts } from '@/lib/admin/company-management.mjs';

export async function GET() {
  const user = await currentUser();
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Admin access required.' }, { status: 403 });
  await ensureAuthSchema();
  const companies = await pool.query(`SELECT o.id,o.name,o.xero_contact_id,o.xero_contact_name,
    COALESCE((SELECT jsonb_object_agg(d.supplier,d.discount_percent) FROM contact_supplier_discounts d
      WHERE d.contact_id=o.xero_contact_id),'{}'::jsonb) AS discounts,
    (SELECT COUNT(*)::int FROM portal_users u WHERE u.organisation_id=o.id) AS user_count
    FROM organisations o ORDER BY o.name,o.id`);
  const defaultDiscount = defaultCompanyDiscount();
  return NextResponse.json({ companies: companies.rows.map((company) => ({ ...company, discounts: { victron: defaultDiscount, renogy: defaultDiscount, ...company.discounts } })), defaultDiscount, canManageUsers: user.canManageUsers });
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user || user.role !== 'admin' || !user.canManageUsers) return NextResponse.json({ error: 'Manage users permission required.' }, { status: 403 });
  await ensureAuthSchema();
  const body = await request.json();
  try {
    const company = await createCompany(pool, { contactId: String(body.xeroContactId || '').trim(), victron: body.victronDiscount,
      renogy: body.renogyDiscount, actor: user, getContact: getXeroContactDetails });
    return NextResponse.json({ ok: true, company }, { status: 201 });
  } catch (error) {
    if (error instanceof CompanyManagementError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('Could not create company:', error);
    return NextResponse.json({ error: 'Unable to verify the stored Xero contact. No company was created. Try again when the Hub is available.' }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  const user = await currentUser();
  if (!user || user.role !== 'admin' || !user.canManageUsers) return NextResponse.json({ error: 'Manage users permission required.' }, { status: 403 });
  await ensureAuthSchema();
  const body = await request.json();
  if (body.action !== 'setDiscounts') return NextResponse.json({ error: 'The company’s Xero identity cannot be changed. Create the correct company and explicitly move each eligible user.' }, { status: 400 });
  try {
    await saveCompanyDiscounts(pool, { organisationId: Number(body.organisationId), victron: body.victronDiscount, renogy: body.renogyDiscount, actor: user });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof CompanyManagementError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
