import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/server';
import { findLiveXeroContacts, XeroLiveLookupError } from '@/lib/xero/oauth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await currentUser();
  if (!user || user.role !== 'admin' || !user.canManageUsers) {
    return NextResponse.json({ error: 'Manage users permission required.' }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const query = (params.get('query') || '').trim();
  if (query.length < 2 || query.length > 100 || /[\x00-\x1f]/.test(query)) {
    return NextResponse.json({ error: 'Enter 2–100 characters to search Xero.' }, { status: 400 });
  }

  try {
    const result = await findLiveXeroContacts(query);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Xero contact lookup failed:', error);
    if (error instanceof XeroLiveLookupError) {
      return NextResponse.json({ error: error.message }, { status: error.status,
        headers: error.retryAfter ? { 'Retry-After': error.retryAfter, 'Cache-Control': 'no-store' } : { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json({ error: 'Unable to search current Xero contacts. Try again later.' }, { status: 502 });
  }
}
