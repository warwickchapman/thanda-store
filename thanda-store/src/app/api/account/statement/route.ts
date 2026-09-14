import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/server';
import { auditAccountAction, customerDocuments } from '@/lib/xero/customer-accounts';

function csvValue(value: unknown) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  try {
    const documents = await customerDocuments(user);
    const statementDocuments = documents.filter((document) => document.type === 'invoice' || document.type === 'credit_note');
    const rows = [['Type', 'Number', 'Date', 'Due date', 'Reference', 'Status', 'Currency', 'Total', 'Paid', 'Open']];
    for (const document of statementDocuments) rows.push([
      document.type, document.number, document.date || '', document.dueDate || '', document.reference,
      document.status, document.currency, document.total.toFixed(2), document.paid.toFixed(2), document.due.toFixed(2),
    ]);
    await auditAccountAction(user, 'statement_downloaded', 'account', user.xeroContactId || undefined, { format: 'csv', documents: statementDocuments.length });
    return new NextResponse(rows.map((row) => row.map(csvValue).join(',')).join('\n'), {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="thanda-account-statement.csv"', 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to create statement.' }, { status: 502 });
  }
}
