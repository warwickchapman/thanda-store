import { cookies } from 'next/headers';
import { currentUser, currentUserFromToken, SESSION_COOKIE } from '@/lib/auth/server';
import pool from '@/lib/db';
import { ApiKeyIssuanceError, issueApiKey } from '@/lib/commerce/api-keys.mjs';
const headers = { 'Cache-Control': 'no-store' };
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in required.' }, { status: 401, headers });
  if (user.impersonatedBy) return Response.json({ error: 'Return to your own account to manage API keys.' }, { status: 403, headers });
  const { rows } = await pool.query('SELECT id,name,prefix,created_at,last_used_at,revoked_at FROM portal_api_keys WHERE user_id=$1 ORDER BY created_at DESC', [user.id]);
  return Response.json({ enabled: user.apiEnabled && Boolean(user.xeroContactId), keys: rows }, { headers });
}
export async function POST(request: Request) {
  const sessionToken = (await cookies()).get(SESSION_COOKIE)?.value;
  const user = await currentUserFromToken(sessionToken);
  if (user?.impersonatedBy) return Response.json({ error: 'Return to your own account to manage API keys.' }, { status: 403, headers });
  if (!user?.apiEnabled || !user.xeroContactId) return Response.json({ error: 'API access is not enabled for this account.' }, { status: 403, headers });
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || '').trim().slice(0, 80);
  if (!name) return Response.json({ error: 'Give this key a name.' }, { status: 400, headers });
  try {
    return Response.json(await issueApiKey(pool, { user, name, sessionToken }), { status: 201, headers });
  } catch (error) {
    return Response.json({ error: error instanceof ApiKeyIssuanceError ? error.message : 'Could not create a key. Reload and check your API access.' }, { status: 409, headers });
  }
}
export async function DELETE(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in required.' }, { status: 401, headers });
  if (user.impersonatedBy) return Response.json({ error: 'Return to your own account to manage API keys.' }, { status: 403, headers });
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!/^[a-f0-9-]{36}$/i.test(id)) return Response.json({ error: 'Invalid key.' }, { status: 400, headers });
  await pool.query('UPDATE portal_api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND user_id=$2', [id,user.id]);
  return Response.json({ ok: true }, { headers });
}
