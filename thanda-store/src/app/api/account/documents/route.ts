import { NextRequest, NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/server';
import { auditAccountAction, customerDocuments } from '@/lib/xero/customer-accounts';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  try {
    const refresh = request.nextUrl.searchParams.get('refresh') === '1';
    const documents = await customerDocuments(user, refresh);
    await auditAccountAction(user, 'account_documents_viewed', 'account', user.xeroContactId || undefined, { refresh });
    return NextResponse.json({ documents, refreshed: refresh });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to load account documents.' }, { status: 502 });
  }
}
