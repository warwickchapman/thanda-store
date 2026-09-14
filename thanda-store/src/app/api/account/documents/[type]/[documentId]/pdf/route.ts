import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/server';
import { customerDocumentPdf } from '@/lib/xero/customer-accounts';

const validTypes = new Set(['quote', 'invoice', 'credit_note']);

export async function GET(_: Request, { params }: { params: Promise<{ type: string; documentId: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  const { type, documentId } = await params;
  if (!validTypes.has(type)) return NextResponse.json({ error: 'Unknown document type.' }, { status: 400 });
  try {
    const { response, number } = await customerDocumentPdf(user, type as 'quote' | 'invoice' | 'credit_note', documentId);
    return new NextResponse(response.body, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${number.replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to load document PDF.' }, { status: 502 });
  }
}
