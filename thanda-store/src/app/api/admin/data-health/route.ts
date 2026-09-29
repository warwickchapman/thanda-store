import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/server';
import { getDataHealth } from '@/lib/data-freshness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await currentUser();
    if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    return NextResponse.json(await getDataHealth({ includeIssues: true }), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Stored sync status could not be loaded.' }, { status: 503 });
  }
}
