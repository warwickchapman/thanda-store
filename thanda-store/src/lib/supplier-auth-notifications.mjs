import crypto from 'node:crypto';
import { authEmailPayload, ensureSupplierAuthSchema } from './supplier-auth-alerts.mjs';
import { deliveryState } from './commerce/notifications.mjs';

// Uses the same Resend cooldown and lock as quote notifications. Each incident
// sends once/admin (stable idempotency key), at most five attempts within 23h,
// and at most three delivery checks. No supplier or Xero requests are made.
export async function runSupplierAuthNotifications(pool, { fetcher = fetch, pause = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  await ensureSupplierAuthSchema(pool);
  const db = await pool.connect();
  let acquired = false;
  let calls = 0;
  try {
    acquired = (await db.query("SELECT pg_try_advisory_lock(hashtext('quote-notification-worker')) AS acquired")).rows[0].acquired;
    if (!acquired) return { calls };
    const incidents = (await db.query("SELECT * FROM supplier_auth_incidents WHERE source_id='renogy' AND resolved_at IS NULL")).rows;
    const admins = incidents.length ? (await db.query("SELECT id,email FROM portal_users WHERE role='admin' AND is_active AND archived_at IS NULL")).rows : [];
    for (const incident of incidents) for (const admin of admins) {
      const payload = authEmailPayload(admin.email, incident.opened_at, {
        from: process.env.OTP_FROM_EMAIL || 'Thanda Store <sales@thanda.solar>',
        baseUrl: process.env.PORTAL_BASE_URL || 'https://store.thanda.solar',
      });
      await db.query(`INSERT INTO supplier_auth_emails(id,incident_id,source_id,user_id,recipient,email_payload)
        VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(incident_id,recipient) DO NOTHING`,
      [crypto.randomUUID(), incident.incident_id, incident.source_id, admin.id, admin.email, JSON.stringify(payload)]);
    }
    await db.query(`UPDATE supplier_auth_emails e SET state='cancelled',updated_at=NOW()
      WHERE state IN ('pending','accepted') AND (NOT EXISTS(SELECT 1 FROM supplier_auth_incidents i
        WHERE i.incident_id=e.incident_id AND i.resolved_at IS NULL)
      OR NOT EXISTS(SELECT 1 FROM portal_users u WHERE u.id=e.user_id AND u.email=e.recipient
        AND u.role='admin' AND u.is_active AND u.archived_at IS NULL))`);
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      await db.query("UPDATE supplier_auth_emails SET last_error='Alert email service is not configured.' WHERE state='pending'");
      return { calls, emailConfigured: false };
    }
    const deadline = now() + 40_000;
    while (calls < 8 && now() < deadline) {
      const state = (await db.query('SELECT next_allowed_at FROM portal_notification_state WHERE id=true')).rows[0];
      if (state?.next_allowed_at && new Date(state.next_allowed_at).getTime() > now()) break;
      const job = (await db.query(`SELECT * FROM supplier_auth_emails WHERE state IN ('pending','accepted')
        AND next_attempt_at<=NOW() ORDER BY next_attempt_at,id LIMIT 1`)).rows[0];
      if (!job) break;
      const sending = job.state === 'pending';
      if ((sending && (job.attempts >= 5 || (job.first_attempt_at && now() - new Date(job.first_attempt_at).getTime() > 23 * 3600_000)))
        || (!sending && job.status_checks >= 3)) {
        await db.query("UPDATE supplier_auth_emails SET state='unconfirmed',last_error='Automatic email retry or delivery-check limit reached.',updated_at=NOW() WHERE id=$1", [job.id]);
        continue;
      }
      await db.query(`UPDATE supplier_auth_emails SET attempts=attempts+$2,status_checks=status_checks+$3,
        first_attempt_at=COALESCE(first_attempt_at,NOW()),next_attempt_at=NOW()+interval '2 minutes' WHERE id=$1`, [job.id, sending ? 1 : 0, sending ? 0 : 1]);
      calls++;
      try {
        const response = await fetcher(`https://api.resend.com/emails${sending ? '' : `/${encodeURIComponent(job.provider_id)}`}`, {
          method: sending ? 'POST' : 'GET', signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - now()))),
          headers: { Authorization: `Bearer ${key}`, ...(sending ? { 'Content-Type': 'application/json', 'Idempotency-Key': `supplier-auth-${job.id}` } : {}) },
          ...(sending ? { body: JSON.stringify(job.email_payload) } : {}),
        });
        const payload = await response.json().catch(() => ({}));
        const headers = Object.fromEntries(['ratelimit-limit','ratelimit-remaining','ratelimit-reset','retry-after','x-resend-daily-quota','x-resend-monthly-quota'].map(h => [h, response.headers.get(h)]));
        await db.query('UPDATE portal_notification_state SET last_response=$1::jsonb,updated_at=NOW() WHERE id=true', [JSON.stringify({ source: 'supplier-auth', status: response.status, ...headers })]);
        if (!response.ok) {
          const name = String(payload.name || 'provider_error').replace(/[^a-z0-9_-]/gi, '').slice(0, 80);
          const permanent = [400,401,403,422].includes(response.status) || (response.status === 409 && name === 'invalid_idempotent_request');
          await db.query(`UPDATE supplier_auth_emails SET state=$2,last_error=$3,next_attempt_at=NOW()+interval '5 minutes',updated_at=NOW() WHERE id=$1`,
            [job.id, permanent ? (sending ? 'failed' : 'unconfirmed') : job.state, `Resend HTTP ${response.status}: ${name}`]);
          if ([429,401,403].includes(response.status)) {
            const retry = response.headers.get('retry-after');
            const seconds = Number(retry);
            const date = Date.parse(retry || '');
            const delay = seconds > 0 ? seconds : Number.isFinite(date) ? Math.max(1, (date - now()) / 1000)
              : /quota/.test(name) ? 86400 : response.status === 429 ? 60 : 3600;
            await db.query("UPDATE portal_notification_state SET next_allowed_at=NOW()+($1*interval '1 second') WHERE id=true", [delay]);
            break;
          }
        } else if (sending) {
          if (typeof payload.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(payload.id)) throw new Error('Unconfirmed response');
          await db.query("UPDATE supplier_auth_emails SET state='accepted',provider_id=$2,last_error=NULL,next_attempt_at=NOW()+interval '1 minute',updated_at=NOW() WHERE id=$1", [job.id, payload.id]);
        } else {
          const state = deliveryState(payload.last_event);
          await db.query("UPDATE supplier_auth_emails SET state=$2,last_error=$3,next_attempt_at=NOW()+interval '15 minutes',updated_at=NOW() WHERE id=$1", [job.id, state, state === 'failed' ? 'Email delivery failed.' : null]);
        }
      } catch {
        await db.query("UPDATE supplier_auth_emails SET last_error='Email outcome is unconfirmed; a bounded retry is scheduled.',next_attempt_at=NOW()+interval '5 minutes',updated_at=NOW() WHERE id=$1", [job.id]);
      }
      if (now() < deadline) await pause(Math.min(1000, deadline - now()));
    }
    return { calls, emailConfigured: true };
  } finally {
    try { if (acquired) await db.query("SELECT pg_advisory_unlock(hashtext('quote-notification-worker'))"); }
    finally { db.release(); }
  }
}
