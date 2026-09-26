// Shared by the web process and bounded local workers. No external requests.
export async function ensureCommerceSchema(pool, { dryRun = false } = {}) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('thanda-commerce-schema-v1'))");
    await db.query(`
      CREATE TABLE IF NOT EXISTS portal_commerce_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
      ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS api_enabled BOOLEAN NOT NULL DEFAULT false;
      CREATE TABLE IF NOT EXISTS contact_supplier_discounts (
        contact_id TEXT NOT NULL, supplier TEXT NOT NULL,
        discount_percent NUMERIC(5,2) NOT NULL CHECK(discount_percent BETWEEN 0 AND 40),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(contact_id,supplier)
      );
      CREATE TABLE IF NOT EXISTS portal_api_keys (
        id UUID PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
        prefix TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS portal_api_rate_limits (
        user_id BIGINT PRIMARY KEY REFERENCES portal_users(id) ON DELETE CASCADE,
        window_start TIMESTAMPTZ NOT NULL, requests INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS portal_quote_requests (
        id UUID PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES portal_users(id), contact_id TEXT NOT NULL,
        source TEXT NOT NULL, request_payload JSONB NOT NULL, context JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ,
        quote_id TEXT UNIQUE, quote_payload JSONB, last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS portal_quote_requests_contact ON portal_quote_requests(contact_id,quote_id);
      CREATE TABLE IF NOT EXISTS portal_quote_notifications (
        id BIGSERIAL PRIMARY KEY, request_id UUID NOT NULL REFERENCES portal_quote_requests(id),
        audience TEXT NOT NULL CHECK(audience IN ('buyer','sales')), email_payload JSONB NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        provider_id TEXT, last_error TEXT, first_attempt_at TIMESTAMPTZ,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), status_checks INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(request_id,audience)
      );
      CREATE TABLE IF NOT EXISTS portal_notification_state (
        id BOOLEAN PRIMARY KEY DEFAULT true CHECK(id), next_allowed_at TIMESTAMPTZ,
        last_response JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO portal_notification_state(id) VALUES(true) ON CONFLICT DO NOTHING;
    `);
    const applied = await db.query("SELECT 1 FROM portal_commerce_migrations WHERE version='contact-pricing-v1'");
    if (!applied.rowCount) {
      const fallback = Math.max(0, Math.min(40, Number(process.env.DEFAULT_B2B_DISCOUNT_PERCENT || 30)));
      // Include implicit defaults, not only explicit rows. Never silently choose
      // one person's price when company users previously had different prices.
      const rates = `SELECT o.xero_contact_id AS contact_id, suppliers.supplier,
        COALESCE(d.discount_percent,$1)::numeric AS rate
        FROM organisations o JOIN portal_users u ON u.organisation_id=o.id
        CROSS JOIN (SELECT supplier FROM user_supplier_discounts UNION SELECT 'victron' UNION SELECT 'renogy') suppliers
        LEFT JOIN user_supplier_discounts d ON d.user_id=u.id AND d.supplier=suppliers.supplier
        WHERE o.xero_contact_id IS NOT NULL`;
      const conflicts = await db.query(`SELECT contact_id,supplier FROM (${rates}) r GROUP BY contact_id,supplier HAVING COUNT(DISTINCT rate)>1`, [fallback]);
      if (conflicts.rowCount) throw new Error('Company discount migration has conflicting user prices; resolve the reviewed migration report before deployment.');
      await db.query(`INSERT INTO contact_supplier_discounts(contact_id,supplier,discount_percent)
        SELECT contact_id,supplier,MIN(rate) FROM (${rates}) r GROUP BY contact_id,supplier
        ON CONFLICT DO NOTHING`, [fallback]);
      await db.query("INSERT INTO portal_commerce_migrations(version) VALUES('contact-pricing-v1')");
    }
    await db.query(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
