import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/server';
import { parseVictronInboundPdf } from '@/lib/victron-inbound-pdf';

export const runtime = 'nodejs';
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const formData = await request.formData();
  const files = formData.getAll('documents').filter((value): value is File => value instanceof File);
  if (!files.length || files.length > 5) return NextResponse.json({ error: 'Upload between one and five Victron invoice PDFs.' }, { status: 400 });
  try {
    const documents = [];
    for (const file of files) {
      if (file.type !== 'application/pdf' || file.size > MAX_DOCUMENT_BYTES) throw new Error(`${file.name} must be a PDF smaller than 10 MB.`);
      documents.push(await parseVictronInboundPdf(new Uint8Array(await file.arrayBuffer())));
    }
    const supplierOrderNumbers = new Set(documents.map((document) => document.supplierOrderNumber));
    if (supplierOrderNumbers.size !== 1) throw new Error('The uploaded documents refer to different Victron orders. Prepare each order separately.');
    const customerPurchaseOrders = new Set(documents.map((document) => document.customerPurchaseOrder).filter(Boolean));
    if (customerPurchaseOrders.size > 1) throw new Error('The uploaded documents have different customer purchase-order references.');
    const lines = new Map<string, { sku: string; description: string; quantity: number; isStockItem: boolean }>();
    for (const document of documents) for (const line of document.lines) {
      const existing = lines.get(line.sku);
      lines.set(line.sku, existing ? { ...existing, quantity: existing.quantity + line.quantity } : line);
    }
    return NextResponse.json({
      supplierOrderNumber: documents[0].supplierOrderNumber,
      customerPurchaseOrder: documents[0].customerPurchaseOrder,
      invoices: documents.map((document) => document.invoiceNumber),
      lines: [...lines.values()],
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to read the uploaded PDF.' }, { status: 400 });
  }
}
