import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { SESSION_COOKIE } from '@/lib/auth/server';
import { ensureAuthSchema } from '@/lib/auth/schema';

async function changeImpersonation(request: Request, targetId: number | null) {
  const origin = request.headers.get('origin');
  const expectedOrigin = new URL(process.env.PORTAL_BASE_URL || request.url).origin;
  if (origin && origin !== expectedOrigin) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
  await ensureAuthSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const session = await client.query(`SELECT s.id,s.impersonated_user_id,u.id AS actor_id,u.email AS actor_email,u.organisation_id
      FROM portal_sessions s JOIN portal_users u ON u.id=s.user_id
      WHERE s.session_hash=$1 AND s.expires_at>now() AND u.is_active AND u.role='admin' AND u.can_manage_users
      FOR UPDATE OF s`, [crypto.createHash('sha256').update(token).digest('hex')]);
    const actor = session.rows[0];
    if (!actor) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'An active user-management session is required.' }, { status: 403 });
    }
    let target = null;
    if (targetId !== null) {
      const found = await client.query(`SELECT u.id,u.email,u.organisation_id,o.name AS company_name
        FROM portal_users u JOIN organisations o ON o.id=u.organisation_id
        WHERE u.id=$1 AND u.is_active AND u.role='buyer' AND o.xero_contact_id IS NOT NULL`, [targetId]);
      target = found.rows[0];
      if (!target) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Choose an active buyer linked to a Xero company.' }, { status: 400 });
      }
    }
    await client.query(`UPDATE portal_sessions SET impersonated_user_id=$2,
      impersonation_expires_at=CASE WHEN $2::bigint IS NULL THEN NULL ELSE now()+interval '1 hour' END
      WHERE id=$1`, [actor.id, target?.id ?? null]);
    await client.query(`INSERT INTO portal_activity_log(user_id,organisation_id,action,resource_type,resource_id,metadata)
      VALUES($1,$2,$3,'user',$4,$5::jsonb)`, [actor.actor_id,actor.organisation_id,
      target ? 'impersonation_started' : 'impersonation_ended',String(target?.id ?? actor.impersonated_user_id ?? actor.actor_id),
      JSON.stringify(target ? { targetEmail: target.email, company: target.company_name } : {})]);
    await client.query('COMMIT');
    return NextResponse.json({ ok: true, target: target ? { id: target.id, email: target.email, company: target.company_name } : null });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Could not change customer view:', error);
    return NextResponse.json({ error: 'Could not change customer view.' }, { status: 500 });
  } finally { client.release(); }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const targetId = Number(body?.userId);
  if (!Number.isSafeInteger(targetId) || targetId < 1) return NextResponse.json({ error: 'Choose a valid user.' }, { status: 400 });
  return changeImpersonation(request, targetId);
}

export async function DELETE(request: Request) { return changeImpersonation(request, null); }
