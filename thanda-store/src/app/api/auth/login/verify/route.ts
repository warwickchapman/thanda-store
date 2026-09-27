import { NextResponse } from 'next/server';
import { canLogin, completeLogin, findLoginUser, SESSION_COOKIE } from '@/lib/auth/server';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const email = String(body.email || '').trim().toLowerCase();
    const otp = String(body.otp || '').trim();

    if (!email || !otp) {
      return NextResponse.json({ error: 'Email and code are required' }, { status: 400 });
    }

    const user = await findLoginUser(email);
    if (!user || !canLogin(user)) {
      return NextResponse.json({ error: 'Login is not available for this account' }, { status: 403 });
    }

    const token = await completeLogin({ userId: Number(user.id), email: user.email,
      organisationId: Number(user.organisation_id) }, otp);
    if (!token) {
      return NextResponse.json({ error: 'Invalid or expired login code' }, { status: 401 });
    }

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
