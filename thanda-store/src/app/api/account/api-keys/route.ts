import { currentUser } from '@/lib/auth/server';
import pool from '@/lib/db';
import { newApiKey } from '@/lib/commerce/api-keys.mjs';
const headers = { 'Cache-Control': 'no-store' };
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in required.' }, { status: 401, headers });
  const { rows } = await pool.query('SELECT id,name,prefix,created_at,last_used_at,revoked_at FROM portal_api_keys WHERE user_id=$1 ORDER BY created_at DESC', [user.id]);
  return Response.json({ enabled: user.apiEnabled && Boolean(user.xeroContactId), keys: rows }, { headers });
}
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user?.apiEnabled || !user.xeroContactId) return Response.json({ error: 'API access is not enabled for this account.' }, { status: 403, headers });
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || '').trim().slice(0, 80);
  if (!name) return Response.json({ error: 'Give this key a name.' }, { status: 400, headers });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const owner = await db.query(`SELECT u.api_enabled,u.is_active,o.xero_contact_id FROM portal_users u
      JOIN organisations o ON o.id=u.organisation_id WHERE u.id=$1 FOR UPDATE OF u,o`, [user.id]);
    if (!owner.rows[0]?.api_enabled || !owner.rows[0]?.is_active || owner.rows[0]?.xero_contact_id !== user.xeroContactId) throw new Error('API access changed. Reload this page.');
    const count = await db.query('SELECT count(*)::int AS n FROM portal_api_keys WHERE user_id=$1 AND revoked_at IS NULL', [user.id]);
    if (count.rows[0].n >= 3) { await db.query('ROLLBACK'); return Response.json({ error: 'Revoke an existing key before creating another (maximum three).' }, { status: 409, headers }); }
    const key = newApiKey();
    await db.query('INSERT INTO portal_api_keys(id,user_id,contact_id,name,token_hash,prefix) VALUES($1,$2,$3,$4,$5,$6)', [key.id,user.id,user.xeroContactId,name,key.hash,key.prefix]);
    await db.query('COMMIT');
    return Response.json({ id: key.id, token: key.token }, { status: 201, headers });
  } catch {
    await db.query('ROLLBACK');
    return Response.json({ error: 'Could not create a key. Reload and check your API access.' }, { status: 409, headers });
  } finally { db.release(); }
}
export async function DELETE(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in required.' }, { status: 401, headers });
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!/^[a-f0-9-]{36}$/i.test(id)) return Response.json({ error: 'Invalid key.' }, { status: 400, headers });
  await pool.query('UPDATE portal_api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND user_id=$2', [id,user.id]);
  return Response.json({ ok: true }, { headers });
}
