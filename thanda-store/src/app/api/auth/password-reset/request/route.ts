import { NextResponse } from 'next/server';
import {
  canLogin,
  createAccountSetupToken,
  findLoginUser,
} from '@/lib/auth/server';
import pool from '@/lib/db';
import { sendAccountSetupEmail } from '@/lib/email/resend';

const SUCCESS_MESSAGE = 'If that email belongs to an active Thanda Store account, a password reset link has been sent.';
const RESET_COOLDOWN_SECONDS = 60;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const email = String(body.email || '').trim().toLowerCase();

    // Always return the same response so this endpoint cannot be used to
    // discover which email addresses have portal accounts.
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return NextResponse.json({ ok: true, message: SUCCESS_MESSAGE });
    }

    const user = await findLoginUser(email);
    if (!user || !canLogin(user)) {
      return NextResponse.json({ ok: true, message: SUCCESS_MESSAGE });
    }

    const recent = await pool.query(
      `
        SELECT 1
        FROM account_setup_tokens
        WHERE user_id = $1
          AND created_at > NOW() - ($2::text || ' seconds')::interval
        LIMIT 1
      `,
      [user.id, RESET_COOLDOWN_SECONDS],
    );
    if (recent.rowCount) {
      return NextResponse.json({ ok: true, message: SUCCESS_MESSAGE });
    }

    const token = await createAccountSetupToken(Number(user.id));
    await sendAccountSetupEmail({ to: user.email, token });
    return NextResponse.json({ ok: true, message: SUCCESS_MESSAGE });
  } catch (error) {
    console.error('Password reset request failed:', error);
    return NextResponse.json({ error: 'Unable to send a password reset email. Please try again later.' }, { status: 500 });
  }
}
