import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { currentUser } from '@/lib/auth/server';
import { ensureAuthSchema } from '@/lib/auth/schema';
import { getLiveXeroContactDetails, XeroLiveLookupError } from '@/lib/xero/oauth';
import crypto from 'node:crypto';
import { createAccountSetupToken, hashPassword } from '@/lib/auth/server';
import { sendAccountSetupEmail } from '@/lib/email/resend';
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
    const contactId = String(body.xeroContactId || '').trim().toLowerCase();
    if (!contactId) return NextResponse.json({ error: 'Select a Xero contact.' }, { status: 400 });
    if (![body.victronDiscount, body.renogyDiscount].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 40)) {
      return NextResponse.json({ error: 'Victron and Renogy discounts must be between 0% and 40%.' }, { status: 400 });
    }
    if (!Array.isArray(body.selectedPeopleEmails) || body.selectedPeopleEmails.length > 20
      || body.selectedPeopleEmails.some((email: unknown) => typeof email !== 'string')) {
      return NextResponse.json({ error: 'Choose up to 20 Xero people to activate, or choose none.' }, { status: 400 });
    }
    const selectedEmails = body.selectedPeopleEmails.map((email: string) => email.trim().toLowerCase());
    if (new Set(selectedEmails).size !== selectedEmails.length || selectedEmails.some((email: string) => !email)) {
      return NextResponse.json({ error: 'Each selected Xero person must have a distinct email.' }, { status: 400 });
    }
    const existing = await pool.query('SELECT id FROM organisations WHERE LOWER(xero_contact_id)=$1 LIMIT 1', [contactId]);
    if (existing.rowCount) return NextResponse.json({ error: 'This Xero contact already has a company record. Open that company to manage its users or pricing.' }, { status: 409 });
    const contact = await getLiveXeroContactDetails(contactId);
    const selectedPeople = await Promise.all(selectedEmails.map(async (email: string) => ({
      email, passwordHash: await hashPassword(crypto.randomBytes(32).toString('hex')),
    })));
    const company = await createCompany(pool, { contactId, victron: body.victronDiscount,
      renogy: body.renogyDiscount, actor: user, getContact: async () => contact,
      selectedPeople });
    const invitations = [];
    for (const person of company.users) {
      let inviteSent = false;
      try {
        const token = await createAccountSetupToken({ userId: Number(person.id), email: person.email,
          organisationId: Number(company.id) });
        if (!token) throw new Error('Account changed before the invitation was issued.');
        await sendAccountSetupEmail({ to: person.email, token });
        inviteSent = true;
      } catch (error) {
        console.error('Created company and buyer but could not send setup email:', error);
      }
      invitations.push({ email: person.email, userId: Number(person.id), inviteSent });
    }
    return NextResponse.json({ ok: true, company, invitations }, { status: invitations.some((invite) => !invite.inviteSent) ? 202 : 201 });
  } catch (error) {
    if (error instanceof CompanyManagementError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof XeroLiveLookupError) return NextResponse.json({ error: error.message }, { status: error.status,
      headers: error.retryAfter ? { 'Retry-After': error.retryAfter } : {} });
    console.error('Could not create company:', error);
    return NextResponse.json({ error: 'Unable to create the company. Check the Xero connection and try again.' }, { status: 503 });
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
