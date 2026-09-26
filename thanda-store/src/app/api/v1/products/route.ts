import pool from '@/lib/db';
import { ensureAuthSchema } from '@/lib/auth/schema';
import { authenticateApiKey, consumeApiRate } from '@/lib/commerce/api-keys.mjs';
import { catalogueExport } from '@/lib/commerce/catalogue-api';
export async function GET(request: Request) {
  await ensureAuthSchema();
  const key = await authenticateApiKey(pool, request.headers.get('authorization'));
  if (!key) return Response.json({ error:'Invalid or disabled API key.' },{status:401,headers:{'Cache-Control':'no-store'}});
  if (!await consumeApiRate(pool,key.user_id)) return Response.json({ error:'Rate limit exceeded (60 requests per minute).' },{status:429,headers:{'Retry-After':'60','Cache-Control':'no-store'}});
  await pool.query('UPDATE portal_api_keys SET last_used_at=now() WHERE id=$1',[key.id]);
  return catalogueExport(request,key.contact_id);
}
