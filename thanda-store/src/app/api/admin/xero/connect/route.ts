import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/server';
import { buildAuthorizationUrl, createState } from '@/lib/xero/oauth';

export async function GET() {
  const user = await currentUser();
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const state = createState();
  const response = NextResponse.redirect(buildAuthorizationUrl(state));
  response.cookies.set('xero_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/',
    maxAge: 10 * 60,
  });
  return response;
}
