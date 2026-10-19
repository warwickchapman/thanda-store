import crypto from 'node:crypto';

export const RENOGY_AUTH_CODE = 'RENOGY_AUTH_FAILED';
export class RenogyAuthError extends Error {
  constructor() {
    super('Renogy authentication failed. Configure the partner login for automatic renewal.');
    this.code = RENOGY_AUTH_CODE;
  }
}

export class RenogyRateLimitError extends Error {
  constructor() { super('Renogy HTTP 429: rate limited. The stored retry deadline must pass before another attempt.'); }
}

export async function ensureSupplierAuthSchema(pool) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('supplier-auth-schema'))");
    await db.query(`CREATE TABLE IF NOT EXISTS supplier_auth_incidents (
      source_id TEXT PRIMARY KEY, incident_id UUID NOT NULL,
      opened_at TIMESTAMPTZ NOT NULL, last_failed_at TIMESTAMPTZ NOT NULL,
      resolved_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS supplier_auth_emails (
      id UUID PRIMARY KEY, incident_id UUID NOT NULL, source_id TEXT NOT NULL,
      user_id BIGINT NOT NULL, recipient TEXT NOT NULL, email_payload JSONB NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      status_checks INTEGER NOT NULL DEFAULT 0, first_attempt_at TIMESTAMPTZ,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), provider_id TEXT,
      last_error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(incident_id,recipient)
    );
    CREATE TABLE IF NOT EXISTS portal_notification_state (
      id BOOLEAN PRIMARY KEY DEFAULT true CHECK(id), next_allowed_at TIMESTAMPTZ,
      last_response JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS renogy_retry_state (
      id BOOLEAN PRIMARY KEY DEFAULT true CHECK(id), next_allowed_at TIMESTAMPTZ,
      response_headers JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    INSERT INTO portal_notification_state(id) VALUES(true) ON CONFLICT DO NOTHING;`);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

export async function renogyRetryDeadline(pool) {
  const result = await pool.query('SELECT next_allowed_at FROM renogy_retry_state WHERE id=true AND next_allowed_at>NOW()');
  return result.rows[0]?.next_allowed_at || null;
}

export async function recordRenogyRateLimit(pool, headers) {
  const retry = headers.get('retry-after');
  const seconds = Number(retry);
  const date = Date.parse(retry || '');
  const delay = seconds > 0 ? seconds : Number.isFinite(date) ? Math.max(1, (date - Date.now()) / 1000) : 60;
  const observed = Object.fromEntries([...headers].filter(([name]) => /retry-after|rate.?limit/i.test(name)));
  await pool.query(`INSERT INTO renogy_retry_state(id,next_allowed_at,response_headers) VALUES(true,NOW()+($1*interval '1 second'),$2::jsonb)
    ON CONFLICT(id) DO UPDATE SET next_allowed_at=GREATEST(renogy_retry_state.next_allowed_at,EXCLUDED.next_allowed_at),response_headers=EXCLUDED.response_headers`, [delay, JSON.stringify(observed)]);
}

export async function recordRenogyAuthFailure(pool) {
  await ensureSupplierAuthSchema(pool);
  await pool.query(`INSERT INTO supplier_auth_incidents(source_id,incident_id,opened_at,last_failed_at)
    VALUES('renogy',$1,NOW(),NOW()) ON CONFLICT(source_id) DO UPDATE SET
    incident_id=CASE WHEN supplier_auth_incidents.resolved_at IS NULL THEN supplier_auth_incidents.incident_id ELSE EXCLUDED.incident_id END,
    opened_at=CASE WHEN supplier_auth_incidents.resolved_at IS NULL THEN supplier_auth_incidents.opened_at ELSE NOW() END,
    last_failed_at=NOW(),resolved_at=NULL`, [crypto.randomUUID()]);
}

export async function resolveRenogyAuthFailure(pool) {
  await ensureSupplierAuthSchema(pool);
  await pool.query("UPDATE supplier_auth_incidents SET resolved_at=NOW() WHERE source_id='renogy' AND resolved_at IS NULL");
}

export async function supplierAuthAlerts(pool) {
  try {
    const { rows } = await pool.query(`SELECT i.source_id,i.opened_at,i.last_failed_at,
      COUNT(e.id) FILTER(WHERE e.state IN ('failed','unconfirmed') OR (e.state='pending' AND e.last_error IS NOT NULL))::int AS email_failed,
      COUNT(e.id) FILTER(WHERE e.state='pending')::int AS email_pending,
      COUNT(e.id) FILTER(WHERE e.state IN ('accepted','delivered'))::int AS email_accepted
      FROM supplier_auth_incidents i LEFT JOIN supplier_auth_emails e ON e.incident_id=i.incident_id
      WHERE i.resolved_at IS NULL GROUP BY i.source_id,i.opened_at,i.last_failed_at ORDER BY i.source_id`);
    return rows;
  } catch (error) { if (error.code === '42P01') return []; throw error; }
}

export function authEmailPayload(recipient, openedAt, { from, baseUrl }) {
  return {
    from, to: recipient, subject: 'Thanda Store: Renogy login needs attention',
    text: `Renogy authentication has failed. Supplier stock and catalogue updates cannot continue.\n\nFirst detected: ${new Date(openedAt).toISOString()}\n\nAsk the Store maintainer to configure or update the Renogy partner login on the server, then verify authentication. Existing quantities may be stale or unknown.\n\nReview: ${baseUrl.replace(/\/$/, '')}/admin/data-health\n\nThis email is sent once per administrator for this incident. The admin banner remains until authentication is verified again.`,
  };
}
