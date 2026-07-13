import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/server';
import { findXeroContactsByEmail } from '@/lib/xero/oauth';

export const dynamic = 'force-dynamic';

const EMAIL_PATTERN = /^[^\s@"<>]+@[^\s@]+\.[^\s@]+$/;

export async function GET(request: Request) {
  const user = await currentUser();
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const email = new URL(request.url).searchParams.get('email')?.trim().toLowerCase() || '';
  if (!EMAIL_PATTERN.test(email)) {
    return NextResponse.json({ error: 'A valid email address is required.' }, { status: 400 });
  }

  try {
    const contacts = await findXeroContactsByEmail(email);
    return NextResponse.json({ contacts }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Xero contact lookup failed:', error);
    return NextResponse.json({ error: 'Unable to search Xero contacts. Reconnect Xero if the issue persists.' }, { status: 502 });
  }
}
