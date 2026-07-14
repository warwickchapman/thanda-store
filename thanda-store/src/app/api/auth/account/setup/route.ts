import { NextResponse } from 'next/server';
import { completeAccountSetup } from '@/lib/auth/server';

const MIN_PASSWORD_LENGTH = 12;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const token = String(body.token || '').trim();
    const password = String(body.password || '');

    if (!token || password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json(
        { error: `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.` },
        { status: 400 },
      );
    }

    const completed = await completeAccountSetup(token, password);
    if (!completed) {
      return NextResponse.json({ error: 'This setup link is invalid or has expired.' }, { status: 400 });
    }

    return NextResponse.json({ ok: true, email: completed });
  } catch (error) {
    console.error('Account setup failed:', error);
    return NextResponse.json({ error: 'Unable to set your password.' }, { status: 500 });
  }
}
