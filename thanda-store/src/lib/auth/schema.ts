import pool from '@/lib/db';

export async function ensureAuthSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS organisations (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      xero_contact_id TEXT,
      xero_contact_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
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

  await pool.query('CREATE INDEX IF NOT EXISTS portal_users_organisation_idx ON portal_users (organisation_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS portal_sessions_user_idx ON portal_sessions (user_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS login_otps_user_idx ON login_otps (user_id)');
}
