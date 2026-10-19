import { currentUser } from '@/lib/auth/server';
import pool from '@/lib/db';
import { supplierAuthAlerts } from '@/lib/supplier-auth-alerts.mjs';

export async function GET() {
  const user = await currentUser();
  if (user?.role !== 'admin' || user.impersonatedBy) return Response.json({ error: 'Admin access required.' }, { status: 403 });
  try {
    return Response.json({ alerts: await supplierAuthAlerts(pool) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch { return Response.json({ error: 'Authentication alert status is unavailable.' }, { status: 503 }); }
}
