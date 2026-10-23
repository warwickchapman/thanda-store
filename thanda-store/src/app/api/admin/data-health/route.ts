import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/server';
import { getDataHealth } from '@/lib/data-freshness';
import pool from '@/lib/db';
import { victronUsage } from '@/lib/victron-http.mjs';
import { queueStaleLocalStockRefresh } from '@/lib/local-stock-refresh.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await currentUser();
    if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    const [health, victron, stockRefresh] = await Promise.all([
      getDataHealth({ includeIssues: true }), victronUsage(pool),
      user.impersonatedBy ? Promise.resolve(null) : queueStaleLocalStockRefresh(pool)
        .catch(() => ({ pending: false, requestedAt: null, lastAttemptAt: null, error: 'A stock update could not be queued. The regular scheduled import remains in place.' })),
    ]);
    return NextResponse.json({ ...health, victron, stockRefresh }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Stored sync status could not be loaded.' }, { status: 503 });
  }
}
