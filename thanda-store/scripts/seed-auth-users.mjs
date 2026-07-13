#!/usr/bin/env node

import bcrypt from 'bcryptjs';
import { createPool } from './product-sync-lib.mjs';

const pool = createPool();

async function ensureAuthSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS organisations (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      xero_contact_id TEXT,
      xero_contact_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS portal_users (
      id BIGSERIAL PRIMARY KEY,
      organisation_id BIGINT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'buyer',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS user_supplier_discounts (
      user_id BIGINT NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
      supplier TEXT NOT NULL,
      discount_percent NUMERIC(5, 2) NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, supplier),
      CONSTRAINT user_supplier_discount_limit CHECK (discount_percent >= 0 AND discount_percent <= 40)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS login_otps (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
      otp_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS portal_sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
      session_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function upsertOrganisation(client, { name, xeroContactId = null, xeroContactName = null }) {
  const result = await client.query(
    `
      INSERT INTO organisations (name, xero_contact_id, xero_contact_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (name) DO UPDATE SET
        xero_contact_id = COALESCE(EXCLUDED.xero_contact_id, organisations.xero_contact_id),
        xero_contact_name = COALESCE(EXCLUDED.xero_contact_name, organisations.xero_contact_name),
        updated_at = NOW()
      RETURNING id
    `,
    [name, xeroContactId, xeroContactName],
  );
  return result.rows[0].id;
}

async function upsertUser(client, { organisationId, username, email, password, role, discounts }) {
  const passwordHash = await bcrypt.hash(password, 12);
  const result = await client.query(
    `
      INSERT INTO portal_users (organisation_id, username, email, password_hash, role)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (username) DO UPDATE SET
        organisation_id = EXCLUDED.organisation_id,
        email = EXCLUDED.email,
        password_hash = EXCLUDED.password_hash,
        role = EXCLUDED.role,
        is_active = true,
        updated_at = NOW()
      RETURNING id
    `,
    [organisationId, username, email, passwordHash, role],
  );
  const userId = result.rows[0].id;
  for (const [supplier, discount] of Object.entries(discounts)) {
    await client.query(
      `
        INSERT INTO user_supplier_discounts (user_id, supplier, discount_percent)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, supplier) DO UPDATE SET discount_percent = EXCLUDED.discount_percent
      `,
      [userId, supplier, discount],
    );
  }
  return userId;
}

async function main() {
  const thandaPassword = process.env.THANDA_PASSWORD;
  const brandonPassword = process.env.BRANDON_PASSWORD;
  if (!thandaPassword) throw new Error('THANDA_PASSWORD is required');
  if (!brandonPassword) throw new Error('BRANDON_PASSWORD is required');

  const client = await pool.connect();
  try {
    await ensureAuthSchema(client);
    const thandaOrgId = await upsertOrganisation(client, { name: 'Thanda Solar' });
    const letsGetLostOrgId = await upsertOrganisation(client, { name: "Let's Get Lost" });

    await upsertUser(client, {
      organisationId: thandaOrgId,
      username: 'thanda',
      email: process.env.THANDA_EMAIL || 'warwick@sensible.co.za',
      password: thandaPassword,
      role: 'admin',
      discounts: { victron: 40, renogy: 40 },
    });

    await upsertUser(client, {
      organisationId: letsGetLostOrgId,
      username: 'brandon_lgl',
      email: 'letsgetlostza@gmail.com',
      password: brandonPassword,
      role: 'buyer',
      discounts: { victron: 35, renogy: 35 },
    });

    console.log('Seeded portal users: thanda, brandon_lgl');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
