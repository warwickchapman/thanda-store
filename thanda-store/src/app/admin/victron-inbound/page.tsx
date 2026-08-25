'use client';

import Link from 'next/link';
import { FileUp, PackageCheck, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type DraftLine = { sku: string; description: string; quantity: number; isStockItem: boolean };
type InboundLine = DraftLine & { id: number; orderedQuantity: number; receivedQuantity: number; receivedAt: string | null };
type InboundOrder = {
  id: number; supplier_order_number: string; customer_purchase_order: string | null; status: 'open' | 'received'; created_at: string; received_at: string | null;
  lines: InboundLine[]; documents: Array<{ id: number; filename: string }>;
};

function nonBlank(value: string) { return value.trim(); }

export default function VictronInboundPage() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [orders, setOrders] = useState<InboundOrder[]>([]);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [supplierOrderNumber, setSupplierOrderNumber] = useState('');
  const [customerPurchaseOrder, setCustomerPurchaseOrder] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [receivingLine, setReceivingLine] = useState<number | null>(null);

  async function loadOrders() {
    const response = await fetch('/api/admin/victron-inbound', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to load inbound Victron orders.');
    setOrders(data.orders || []);
  }
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadOrders().catch((cause) => setError(cause instanceof Error ? cause.message : 'Unable to load orders.'));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function prepareFromInvoices() {
    if (!selectedFiles.length) { setError('Choose one or more Victron invoice PDFs first.'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const formData = new FormData();
      selectedFiles.forEach((file) => formData.append('documents', file));
      const response = await fetch('/api/admin/victron-inbound/parse', { method: 'POST', body: formData });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to read the uploaded invoices.');
      setSupplierOrderNumber(data.supplierOrderNumber || '');
      setCustomerPurchaseOrder(data.customerPurchaseOrder || '');
      setLines(data.lines || []);
      setMessage(`Prepared ${data.lines.length} lines from invoice${data.invoices.length === 1 ? '' : 's'} ${data.invoices.join(', ')}. Review before saving.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to read invoices.'); }
    finally { setBusy(false); }
  }

  function addLine() { setLines((current) => [...current, { sku: '', description: '', quantity: 1, isStockItem: true }]); }
  function updateLine(index: number, patch: Partial<DraftLine>) { setLines((current) => current.map((line, currentIndex) => currentIndex === index ? { ...line, ...patch } : line)); }

  async function saveOrder() {
    if (!nonBlank(supplierOrderNumber) || !lines.length) { setError('Add an order number and at least one inbound line.'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const formData = new FormData();
      formData.set('order', JSON.stringify({ supplierOrderNumber, customerPurchaseOrder, lines }));
      selectedFiles.forEach((file) => formData.append('documents', file));
      const response = await fetch('/api/admin/victron-inbound', { method: 'POST', body: formData });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to save this inbound order.');
      setLines([]); setSupplierOrderNumber(''); setCustomerPurchaseOrder(''); setSelectedFiles([]);
      if (fileInput.current) fileInput.current.value = '';
      setMessage('Inbound Victron order saved. Confirm each stock line when it physically arrives.');
      await loadOrders();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to save order.'); }
    finally { setBusy(false); }
  }

  async function receiveLine(lineId: number) {
    setReceivingLine(lineId); setError(''); setMessage('');
    try {
      const response = await fetch('/api/admin/victron-inbound', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lineId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to record receipt.');
      setMessage(data.complete ? 'All stock lines are received. The next Xero stock reconciliation has been requested.' : 'Receipt recorded. The next Xero stock reconciliation has been requested.');
      await loadOrders();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to record receipt.'); }
    finally { setReceivingLine(null); }
  }

  return <main className="min-h-screen bg-zinc-50 text-zinc-950">
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-col justify-between gap-3 border-b border-zinc-200 pb-4 sm:flex-row sm:items-end">
        <div><h1 className="text-2xl font-bold">Victron inbound stock</h1><p className="text-sm text-zinc-500">Prepare expected deliveries, retain their invoices, and record physical receipt.</p></div>
        <Link href="/" className="text-sm font-semibold text-zinc-700">Back to store</Link>
      </div>
      <nav className="mb-6 flex gap-1 border-b border-zinc-200" aria-label="Inventory planning"><Link href="/admin/replenishment" className="px-4 py-2 text-sm font-semibold text-zinc-600 hover:text-zinc-950">Replenishment</Link><span className="border-b-2 border-zinc-950 px-4 py-2 text-sm font-bold">Inbound deliveries</span></nav>
      {message && <div className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800">{message}</div>}
      {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

      <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="mb-4"><h2 className="text-lg font-bold">Prepare an inbound order</h2><p className="mt-1 text-sm text-zinc-500">Upload Victron tax-invoice PDFs to prefill the order, or enter lines manually. Source PDFs are optional and retained with the order.</p></div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="grid gap-1 text-sm font-semibold">Victron invoice PDFs (optional)
            <input ref={fileInput} type="file" accept="application/pdf" multiple onChange={(event) => setSelectedFiles(Array.from(event.target.files || []))} className="block h-10 w-full rounded-md border border-zinc-300 p-1.5 text-sm font-normal" />
          </label>
          <button type="button" onClick={() => void prepareFromInvoices()} disabled={busy || !selectedFiles.length} className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-4 text-sm font-semibold disabled:opacity-60"><FileUp className="h-4 w-4" />{busy ? 'Reading' : 'Read invoices'}</button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm font-semibold">Victron order number<input value={supplierOrderNumber} onChange={(event) => setSupplierOrderNumber(event.target.value)} className="h-10 rounded-md border border-zinc-300 px-3 font-normal" placeholder="e.g. 8800116" /></label>
          <label className="grid gap-1 text-sm font-semibold">Your PO reference<input value={customerPurchaseOrder} onChange={(event) => setCustomerPurchaseOrder(event.target.value)} className="h-10 rounded-md border border-zinc-300 px-3 font-normal" placeholder="Optional" /></label>
        </div>
        <div className="mt-5 overflow-x-auto rounded-md border border-zinc-200">
          <table className="min-w-full text-sm"><thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500"><tr><th className="px-3 py-2">SKU</th><th className="px-3 py-2">Description</th><th className="px-3 py-2">Qty</th><th className="px-3 py-2">Stock item</th><th className="px-3 py-2"><span className="sr-only">Remove</span></th></tr></thead>
            <tbody>{lines.map((line, index) => <tr key={`${line.sku}-${index}`} className="border-t border-zinc-100"><td className="p-2"><input value={line.sku} onChange={(event) => updateLine(index, { sku: event.target.value.toUpperCase() })} className="h-9 w-36 rounded border border-zinc-300 px-2" /></td><td className="p-2"><input value={line.description} onChange={(event) => updateLine(index, { description: event.target.value })} className="h-9 min-w-72 w-full rounded border border-zinc-300 px-2" /></td><td className="p-2"><input type="number" min="1" value={line.quantity} onChange={(event) => updateLine(index, { quantity: Number(event.target.value) })} className="h-9 w-20 rounded border border-zinc-300 px-2" /></td><td className="p-2"><input type="checkbox" checked={line.isStockItem} onChange={(event) => updateLine(index, { isStockItem: event.target.checked })} /></td><td className="p-2"><button type="button" onClick={() => setLines((current) => current.filter((_, currentIndex) => currentIndex !== index))} className="text-xs font-semibold text-red-700">Remove</button></td></tr>)}</tbody>
          </table>
        </div>
        <div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={addLine} className="h-10 rounded-md border border-zinc-300 bg-white px-4 text-sm font-semibold">Add line</button><button type="button" onClick={() => void saveOrder()} disabled={busy || !lines.length} className="inline-flex h-10 items-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white disabled:opacity-60"><PackageCheck className="h-4 w-4" />Save inbound order</button></div>
      </section>

      <section><div className="mb-3 flex items-center justify-between"><div><h2 className="text-lg font-bold">Expected and received</h2><p className="text-sm text-zinc-500">Confirm a line only after counting the physical item. Promotional material is kept for reference but does not affect stock receipt completion.</p></div><button type="button" onClick={() => void loadOrders().catch((cause) => setError(cause instanceof Error ? cause.message : 'Unable to refresh.'))} className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 text-sm font-semibold"><RefreshCw className="h-4 w-4" />Refresh</button></div>
        <div className="grid gap-4">{orders.map((order) => <article key={order.id} className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm"><div className="mb-3 flex flex-col justify-between gap-2 sm:flex-row"><div><h3 className="font-bold">Victron order {order.supplier_order_number}</h3><p className="text-sm text-zinc-500">{order.customer_purchase_order ? `PO ${order.customer_purchase_order} · ` : ''}Created {new Date(order.created_at).toLocaleDateString()}</p>{order.documents.length > 0 && <p className="mt-1 text-xs text-zinc-500">Invoices: {order.documents.map((document, index) => <span key={document.id}>{index > 0 && ', '}<a href={`/api/admin/victron-inbound/documents/${document.id}`} target="_blank" rel="noreferrer" className="font-semibold text-zinc-700 underline">{document.filename}</a></span>)}</p>}</div><span className={`inline-flex h-6 items-center self-start rounded-full px-2 text-xs font-bold ${order.status === 'received' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-900'}`}>{order.status === 'received' ? 'Received' : 'Awaiting receipt'}</span></div>
          <div className="divide-y divide-zinc-100 border-t border-zinc-100">{order.lines.map((line) => <div key={line.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-semibold">{line.sku} <span className="font-normal text-zinc-600">· {line.description}</span></p><p className="text-sm text-zinc-500">{line.receivedQuantity}/{line.orderedQuantity} received {line.isStockItem ? '' : '· promotional/reference item'}</p></div>{line.receivedQuantity >= line.orderedQuantity ? <span className="text-sm font-semibold text-green-700">Received</span> : <button type="button" onClick={() => void receiveLine(line.id)} disabled={receivingLine === line.id} className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white disabled:opacity-60"><PackageCheck className="h-4 w-4" />{receivingLine === line.id ? 'Recording' : 'Confirm received'}</button>}</div>)}</div>
        </article>)}{!orders.length && <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">No Victron inbound orders have been prepared yet.</div>}</div>
      </section>
    </div>
  </main>;
}
