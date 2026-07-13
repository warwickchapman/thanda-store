import { NextResponse } from 'next/server';

export default function middleware(request: Request) {
  const url = new URL(request.url);
  const cookie = request.headers.get('cookie') || '';
  const hasSession = /(?:^|;\s*)thanda_session=/.test(cookie);

  if (url.pathname === '/login' || url.pathname === '/set-password') {
    if (hasSession) return NextResponse.redirect(new URL('/', request.url));
    return NextResponse.next();
  }

  if (!hasSession) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('next', url.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|logos|banners|product-images|file.svg|globe.svg|next.svg|vercel.svg|window.svg).*)'],
};
