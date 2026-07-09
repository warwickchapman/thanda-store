import { NextResponse } from 'next/server';
import { destroySession, SESSION_COOKIE } from '@/lib/auth/server';

export async function POST(request: Request) {
  const token = request.headers.get('cookie')?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
  await destroySession(token);
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
