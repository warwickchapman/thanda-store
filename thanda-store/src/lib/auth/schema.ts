import pool from '@/lib/db';

export async function ensureAuthSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS organisations (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      xero_contact_id TEXT,
      xero_contact_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Organisation names are Xero-owned display data. Contact ID is the stable
  // identity and avoids treating a mutable display name as a unique key.
  await pool.query('ALTER TABLE organisations DROP CONSTRAINT IF EXISTS organisations_name_key');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS organisations_xero_contact_id_unique ON organisations (xero_contact_id) WHERE xero_contact_id IS NOT NULL');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS portal_users (
      id BIGSERIAL PRIMARY KEY,
      organisation_id BIGINT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'buyer',
      is_active BOOLEAN NOT NULL DEFAULT true,
      xero_person_kind TEXT NOT NULL DEFAULT 'manual',
      xero_person_email TEXT,
      archived_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Pre-launch migration: email is the only login identifier. Keep the Xero
  // person source locally so a reconciliation can revoke removed access.
  await pool.query('ALTER TABLE portal_users DROP COLUMN IF EXISTS username');
  await pool.query("ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS xero_person_kind TEXT NOT NULL DEFAULT 'manual'");
  await pool.query('ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS xero_person_email TEXT');
  await pool.query('ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS portal_users_email_lower_unique ON portal_users (LOWER(email))');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_supplier_discounts (
      user_id BIGINT NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
      supplier TEXT NOT NULL,
      discount_percent NUMERIC(5, 2) NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, supplier),
      CONSTRAINT user_supplier_discount_limit CHECK (discount_percent >= 0 AND discount_percent <= 40)
    )
  `);

  await pool.query(`
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS portal_sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
      session_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_setup_tokens (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS portal_users_organisation_idx ON portal_users (organisation_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS portal_users_xero_person_idx ON portal_users (organisation_id, xero_person_kind)');
  await pool.query('CREATE INDEX IF NOT EXISTS portal_sessions_user_idx ON portal_sessions (user_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS login_otps_user_idx ON login_otps (user_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS account_setup_tokens_user_idx ON account_setup_tokens (user_id)');
}
