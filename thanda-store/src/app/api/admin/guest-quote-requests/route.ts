import { currentUser } from '@/lib/auth/server';
import pool from '@/lib/db';
import { RfqError, ensurePublicRfqSchema, listPublicRfqs, readRfqJson, requireRfqOrigin, updatePublicRfq } from '@/lib/commerce/public-rfq.mjs';

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export async function GET() {
  const user = await currentUser();
  if (user?.role !== 'admin' || user.impersonatedBy) return Response.json({ error: 'Admin access required.' }, { status: 403, headers: privateHeaders });
  try {
    await ensurePublicRfqSchema(pool);
    return Response.json({ requests: await listPublicRfqs(pool) }, { headers: privateHeaders });
  } catch {
    return Response.json({ error: 'Unable to load website enquiries.' }, { status: 503, headers: privateHeaders });
  }
}

export async function PATCH(request: Request) {
  const user = await currentUser();
  if (user?.role !== 'admin' || user.impersonatedBy) return Response.json({ error: 'Admin access required.' }, { status: 403, headers: privateHeaders });
  try {
    requireRfqOrigin(request);
    const body = await readRfqJson(request);
    await ensurePublicRfqSchema(pool);
    return Response.json(await updatePublicRfq(pool, body, user.id), { headers: privateHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof RfqError ? error.message : 'Unable to update the enquiry.' }, { status: error instanceof RfqError ? error.status : 503, headers: privateHeaders });
  }
}
