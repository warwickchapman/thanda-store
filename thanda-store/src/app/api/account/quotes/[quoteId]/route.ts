import { NextRequest, NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/server';
import { updateQuoteAcceptance } from '@/lib/xero/customer-accounts';

export async function POST(request: NextRequest, { params }: { params: Promise<{ quoteId: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  const { quoteId } = await params;
  const body = await request.json().catch(() => ({}));
  if (typeof body.accept !== 'boolean') return NextResponse.json({ error: 'Accept must be true or false.' }, { status: 400 });
  try {
    await updateQuoteAcceptance(user, quoteId, body.accept);
    return NextResponse.json({ message: body.accept ? 'Quote accepted.' : 'Quote returned to sent.' });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to update quote.' }, { status: 502 });
  }
}
