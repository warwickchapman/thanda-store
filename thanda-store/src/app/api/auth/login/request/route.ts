import { NextResponse } from 'next/server';
import { canLogin, createLoginOtp, findLoginUser, verifyPassword } from '@/lib/auth/server';
import { sendOtpEmail } from '@/lib/email/resend';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
    }

    const user = await findLoginUser(email);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
    }

    if (!canLogin(user)) {
      return NextResponse.json(
        { error: 'This account is not linked to a Xero contact yet. Please contact Thanda Store.' },
        { status: 403 },
      );
    }

    const otp = await createLoginOtp({ userId: Number(user.id), email: user.email,
      organisationId: Number(user.organisation_id), passwordHash: user.password_hash });
    if (!otp) return NextResponse.json({ error: 'Your account changed during sign-in. Please start again.' }, { status: 409 });
    await sendOtpEmail({ to: user.email, otp });

    return NextResponse.json({ ok: true, email: user.email.replace(/(^.).*(@.*$)/, '$1***$2') });
  } catch (error) {
    console.error('Login OTP request failed:', error);
    return NextResponse.json({ error: 'Failed to request login code' }, { status: 500 });
  }
}
