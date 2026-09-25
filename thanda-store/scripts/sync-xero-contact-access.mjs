#!/usr/bin/env node

import { hubFetch, hubStatus } from '../src/lib/xero/hub.mjs';
import pg from 'pg';

const CONTACTS_URL = '/Contacts';
const EXCLUDED_ADDITIONAL_PERSON_EMAILS = new Set(['sales@thanda.solar']);

async function xeroContact(token, contactId) {
  const response = await hubFetch(`${CONTACTS_URL}/${encodeURIComponent(contactId)}`, {
    headers: {
      Accept: 'application/json',
    },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Xero contact ${contactId} fetch failed: ${response.status}`);
  const contact = payload.Contacts?.[0];
  if (!contact || String(contact.ContactStatus || '').toUpperCase() === 'ARCHIVED') {
    return { name: '', emails: new Set() };
  }
  const primaryEmail = String(contact.EmailAddress || '').trim().toLowerCase();
  const additionalEmails = (contact.ContactPersons || [])
    .map((person) => String(person.EmailAddress || '').trim().toLowerCase())
    .filter((email) => email && !EXCLUDED_ADDITIONAL_PERSON_EMAILS.has(email));
  return { name: String(contact.Name || '').trim(), emails: new Set([primaryEmail, ...additionalEmails].filter(Boolean)) };
}

async function ensurePortalUserSchema(client) {
  // The timer may run before any authenticated web request has applied the
  // application migration after deployment.
  await client.query('ALTER TABLE portal_users DROP COLUMN IF EXISTS username');
  await client.query("ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS xero_person_kind TEXT NOT NULL DEFAULT 'manual'");
  await client.query('ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS xero_person_email TEXT');
  await client.query('ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ');
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS portal_users_email_lower_unique ON portal_users (LOWER(email))');
  await client.query('CREATE INDEX IF NOT EXISTS portal_users_xero_person_idx ON portal_users (organisation_id, xero_person_kind)');
  await client.query('ALTER TABLE organisations DROP CONSTRAINT IF EXISTS organisations_name_key');
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS organisations_xero_contact_id_unique ON organisations (xero_contact_id) WHERE xero_contact_id IS NOT NULL');
}

async function main() {
  const token = await hubStatus();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const stats = { contacts: 0, checkedUsers: 0, archivedUsers: 0 };

  try {
    await ensurePortalUserSchema(client);
    const organisations = await client.query(`
      SELECT xero_contact_id
      FROM organisations
      WHERE xero_contact_id IS NOT NULL
    `);
    const result = await client.query(`
      SELECT u.id, u.xero_person_email, o.xero_contact_id
      FROM portal_users u
      JOIN organisations o ON o.id = u.organisation_id
      WHERE u.is_active = true
        AND u.xero_person_kind IN ('primary', 'additional')
        AND o.xero_contact_id IS NOT NULL
    `);
    const usersByContact = new Map();
    for (const organisation of organisations.rows) {
      usersByContact.set(String(organisation.xero_contact_id), []);
    }
    for (const user of result.rows) {
      const contactId = String(user.xero_contact_id);
      usersByContact.set(contactId, [...(usersByContact.get(contactId) || []), user]);
    }

    for (const [contactId, users] of usersByContact) {
      stats.contacts += 1;
      const contact = await xeroContact(token, contactId);
      const allowedEmails = contact.emails;
      if (contact.name) {
        await client.query(
          'UPDATE organisations SET name = $2, xero_contact_name = $2, updated_at = NOW() WHERE xero_contact_id = $1',
          [contactId, contact.name],
        );
      }
      const missingIds = users
        .filter((user) => !allowedEmails.has(String(user.xero_person_email || '').toLowerCase()))
        .map((user) => Number(user.id));
      stats.checkedUsers += users.length;
      if (!missingIds.length) continue;

      await client.query('BEGIN');
      try {
        await client.query('UPDATE portal_users SET is_active = false, archived_at = NOW(), updated_at = NOW() WHERE id = ANY($1::bigint[])', [missingIds]);
        await client.query('DELETE FROM portal_sessions WHERE user_id = ANY($1::bigint[])', [missingIds]);
        await client.query('UPDATE login_otps SET consumed_at = NOW() WHERE user_id = ANY($1::bigint[]) AND consumed_at IS NULL', [missingIds]);
        await client.query('UPDATE account_setup_tokens SET consumed_at = NOW() WHERE user_id = ANY($1::bigint[]) AND consumed_at IS NULL', [missingIds]);
        await client.query('COMMIT');
        stats.archivedUsers += missingIds.length;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log(JSON.stringify(stats, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
