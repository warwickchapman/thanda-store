import { NextRequest, NextResponse } from 'next/server';
import { buildAuthorizationUrl, createState, xeroConfig } from '@/lib/xero/oauth';

export async function GET(request: NextRequest) {
  try {
    const config = xeroConfig();
    if (config.connectSecret) {
      const providedSecret = request.nextUrl.searchParams.get('secret');
      if (providedSecret !== config.connectSecret) {
        return new NextResponse('Not found', { status: 404 });
      }
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
  } catch (error) {
    console.error('Xero connect error:', error);
    return new NextResponse('Xero is not configured', { status: 500 });
  }
}
