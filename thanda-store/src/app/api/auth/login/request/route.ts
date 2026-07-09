import { NextResponse } from 'next/server';
import { canLogin, createLoginOtp, findLoginUser, verifyPassword } from '@/lib/auth/server';
import { sendOtpEmail } from '@/lib/email/resend';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const username = String(body.username || '').trim();
    const password = String(body.password || '');

    if (!username || !password) {
      return NextResponse.json({ error: 'Username and password are required' }, { status: 400 });
    }

    const user = await findLoginUser(username);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
    }

    if (!canLogin(user)) {
      return NextResponse.json(
        { error: 'This account is not linked to a Xero contact yet. Please contact Thanda Store.' },
        { status: 403 },
      );
    }

    const otp = await createLoginOtp(Number(user.id));
    await sendOtpEmail({ to: user.email, username: user.username, otp });

    return NextResponse.json({ ok: true, email: user.email.replace(/(^.).*(@.*$)/, '$1***$2') });
  } catch (error) {
    console.error('Login OTP request failed:', error);
    return NextResponse.json({ error: 'Failed to request login code' }, { status: 500 });
  }
}
