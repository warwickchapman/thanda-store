import { NextRequest, NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/server';
import { auditAccountAction, customerDocumentsPage, type CustomerDocumentView } from '@/lib/xero/customer-accounts';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  try {
    const refresh = request.nextUrl.searchParams.get('refresh') === '1';
    const page = Number(request.nextUrl.searchParams.get('page') || '1');
    const query = request.nextUrl.searchParams.get('query') || '';
    const requestedView = request.nextUrl.searchParams.get('view') || 'current';
    const view = ['current', 'invoice', 'quote', 'credit_note'].includes(requestedView)
      ? requestedView as CustomerDocumentView : 'current';
    const result = await customerDocumentsPage(user, { refresh, page, query, view });
    await auditAccountAction(user, 'account_documents_viewed', 'account', user.xeroContactId || undefined, { refresh, page: result.page, view, query: query || null });
    return NextResponse.json({ ...result, refreshed: refresh });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to load account documents.' }, { status: 502 });
  }
}
