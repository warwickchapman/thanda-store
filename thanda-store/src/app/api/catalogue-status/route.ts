import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/server';
import { getCatalogueStatus } from '@/lib/data-freshness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    if (!await currentUser()) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    return NextResponse.json(await getCatalogueStatus(), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Stock update information could not be loaded.' }, { status: 503 });
  }
}
