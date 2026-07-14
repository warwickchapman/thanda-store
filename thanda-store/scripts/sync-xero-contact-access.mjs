#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONTACTS_URL = 'https://api.xero.com/api.xro/2.0/Contacts';
const DEFAULT_TOKEN_FILE = '/var/lib/thanda-store/xero-token.json';
const EXCLUDED_ADDITIONAL_PERSON_EMAILS = new Set(['sales@thanda.solar']);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function config() {
  return {
    clientId: requiredEnv('XERO_CLIENT_ID'),
    clientSecret: requiredEnv('XERO_CLIENT_SECRET'),
    tokenFile: process.env.XERO_TOKEN_FILE || DEFAULT_TOKEN_FILE,
  };
}

async function refreshTokenIfNeeded(settings, token) {
  const expiresAt = token.expires_at ? Date.parse(token.expires_at) : 0;
  if (token.access_token && token.tenant_id && expiresAt > Date.now() + 60_000) return token;
  if (!token.refresh_token) throw new Error('Xero token file does not contain a refresh token');

  const credentials = Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString('base64');
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token }),
  });
  const refreshed = await response.json();
  if (!response.ok) throw new Error(`Xero token refresh failed: ${response.status} ${refreshed.error || ''}`.trim());

  const updated = {
    ...token,
    ...refreshed,
    expires_at: new Date(Date.now() + Number(refreshed.expires_in || 0) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(settings.tokenFile), { recursive: true });
  await fs.writeFile(settings.tokenFile, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
  return updated;
}

async function xeroEmails(token, contactId) {
  const response = await fetch(`${CONTACTS_URL}/${encodeURIComponent(contactId)}`, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'xero-tenant-id': token.tenant_id,
      Accept: 'application/json',
    },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Xero contact ${contactId} fetch failed: ${response.status}`);
  const contact = payload.Contacts?.[0];
  if (!contact || String(contact.ContactStatus || '').toUpperCase() === 'ARCHIVED') return new Set();
  const primaryEmail = String(contact.EmailAddress || '').trim().toLowerCase();
  const additionalEmails = (contact.ContactPersons || [])
    .map((person) => String(person.EmailAddress || '').trim().toLowerCase())
    .filter((email) => email && !EXCLUDED_ADDITIONAL_PERSON_EMAILS.has(email));
  return new Set([primaryEmail, ...additionalEmails].filter(Boolean));
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
}

async function main() {
  const settings = config();
  const token = await refreshTokenIfNeeded(settings, JSON.parse(await fs.readFile(settings.tokenFile, 'utf8')));
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const stats = { contacts: 0, checkedUsers: 0, archivedUsers: 0 };

  try {
    await ensurePortalUserSchema(client);
    const result = await client.query(`
      SELECT u.id, u.xero_person_email, o.xero_contact_id
      FROM portal_users u
      JOIN organisations o ON o.id = u.organisation_id
      WHERE u.is_active = true
        AND u.xero_person_kind IN ('primary', 'additional')
        AND o.xero_contact_id IS NOT NULL
    `);
    const usersByContact = new Map();
    for (const user of result.rows) {
      const contactId = String(user.xero_contact_id);
      usersByContact.set(contactId, [...(usersByContact.get(contactId) || []), user]);
    }

    for (const [contactId, users] of usersByContact) {
      stats.contacts += 1;
      const allowedEmails = await xeroEmails(token, contactId);
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
