import { NextResponse } from 'next/server';
import { canLogin, consumeLoginOtp, createSession, findLoginUser, SESSION_COOKIE } from '@/lib/auth/server';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const username = String(body.username || '').trim();
    const otp = String(body.otp || '').trim();

    if (!username || !otp) {
      return NextResponse.json({ error: 'Username and code are required' }, { status: 400 });
    }

    const user = await findLoginUser(username);
    if (!user || !canLogin(user)) {
      return NextResponse.json({ error: 'Login is not available for this account' }, { status: 403 });
    }

    const valid = await consumeLoginOtp(Number(user.id), otp);
    if (!valid) {
      return NextResponse.json({ error: 'Invalid or expired login code' }, { status: 401 });
    }

    const token = await createSession(Number(user.id));
    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
      maxAge: 60 * 60 * 24 * 14,
    });
    return response;
  } catch (error) {
    console.error('Login OTP verification failed:', error);
    return NextResponse.json({ error: 'Failed to verify login code' }, { status: 500 });
  }
}
