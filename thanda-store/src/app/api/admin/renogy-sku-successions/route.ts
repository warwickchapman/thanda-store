import { currentUser } from '@/lib/auth/server';
import { validCustomerViewOrigin as validAdminOrigin } from '@/lib/auth/impersonation-origin.mjs';
import pool from '@/lib/db';
import {
  listRenogySkuSuccessions, saveRenogySkuSuccession, removeRenogySkuSuccession,
  RenogySkuSuccessionInputError,
} from '@/lib/renogy-sku-successions.mjs';

export const runtime = 'nodejs';

export async function GET() {
  const user = await currentUser();
  if (user?.role !== 'admin' || user.impersonatedBy) return Response.json({ error: 'Admin access required.' }, { status: 403 });
  try {
    return Response.json(await listRenogySkuSuccessions(pool), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch { return Response.json({ error: 'The saved Renogy catalogue is unavailable. Try again shortly.' }, { status: 503 }); }
}

async function change(request: Request, removing: boolean) {
  const user = await currentUser();
  if (user?.role !== 'admin' || user.impersonatedBy) return Response.json({ error: 'Admin access required.' }, { status: 403 });
  if (!validAdminOrigin(request, { portalBaseUrl: process.env.PORTAL_BASE_URL, nodeEnv: process.env.NODE_ENV })) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  try {
    let input;
    try { input = await request.json(); }
    catch { throw new RenogySkuSuccessionInputError('Choose the previous and replacement SKUs.'); }
    const pair = removing ? await removeRenogySkuSuccession(pool, input) : await saveRenogySkuSuccession(pool, {
      predecessorSku: input?.predecessorSku,
      successorSku: input?.successorSku,
      sourceDescription: `Manual entry by administrator (${user.email})`,
    });
    return Response.json({ ...pair, message: removing ? 'Renogy replacement link removed.' : 'Renogy replacement link saved.' });
  } catch (error) {
    if (error instanceof RenogySkuSuccessionInputError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: 'Unable to confirm the change. Refresh the replacement list before trying again.' }, { status: 503 });
  }
}

export const POST = (request: Request) => change(request, false);
export const DELETE = (request: Request) => change(request, true);
