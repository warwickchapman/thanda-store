'use client';

import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

type ReportItem = { sku: string; name: string; sales30: number; sales90: number; dailyDemand: number; localStock: number; inbound: number; supplierStock: number; minimumStock: number; daysCover: number | null; reorderPoint: number; targetStock: number; suggestedOrder: number; status: 'order_now' | 'top_up' | 'covered'; lastSoldAt: string | null };
type Report = { items: ReportItem[]; policy: { leadTimeDays: number; safetyStockDays: number; targetCoverDays: number } };
function number(value: number, maximumFractionDigits = 0) { return new Intl.NumberFormat('en-ZA', { maximumFractionDigits }).format(value); }

export default function ReplenishmentPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/admin/replenishment', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load the replenishment report.');
      setReport(data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load the report.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, []);
  return <main className="min-h-screen bg-zinc-50 text-zinc-950"><div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
    <div className="mb-6 flex flex-col justify-between gap-3 border-b border-zinc-200 pb-4 sm:flex-row sm:items-end"><div><h1 className="text-2xl font-bold">Inventory planning</h1><p className="text-sm text-zinc-500">Victron replenishment recommendations from sales, KZN stock, and open inbound deliveries.</p></div><Link href="/" className="text-sm font-semibold text-zinc-700">Back to store</Link></div>
    <nav className="mb-6 flex gap-1 border-b border-zinc-200" aria-label="Inventory planning"><span className="border-b-2 border-zinc-950 px-4 py-2 text-sm font-bold">Replenishment</span><Link href="/admin/victron-inbound" className="px-4 py-2 text-sm font-semibold text-zinc-600 hover:text-zinc-950">Inbound deliveries</Link><Link href="/admin/victron-stock-minima" className="px-4 py-2 text-sm font-semibold text-zinc-600 hover:text-zinc-950">Stock minima</Link></nav>
    {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
    {report && <div className="mb-5 flex flex-col justify-between gap-3 rounded-lg border border-zinc-200 bg-white p-4 text-sm shadow-sm sm:flex-row sm:items-center"><p><span className="font-bold">Policy:</span> higher of 30- or 90-day sales rate, or the configured stock minimum; {report.policy.leadTimeDays}-day lead time; {report.policy.safetyStockDays}-day safety stock; {report.policy.targetCoverDays}-day target cover.</p><button type="button" onClick={() => void load()} disabled={loading} className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-3 text-sm font-semibold disabled:opacity-60"><RefreshCw className="h-4 w-4" />Refresh</button></div>}
    <section className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm"><table className="min-w-[1120px] w-full text-sm"><thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500"><tr><th className="px-4 py-3">Item to order</th><th className="px-3 py-3 text-right">30d</th><th className="px-3 py-3 text-right">90d</th><th className="px-3 py-3 text-right">Min</th><th className="bg-sky-100 px-3 py-3 text-right font-bold text-sky-950">KZN stock</th><th className="px-3 py-3 text-right">Inbound</th><th className="px-3 py-3 text-right">Days cover</th><th className="px-3 py-3 text-right">Order point</th><th className="px-3 py-3 text-right">Suggested</th><th className="px-4 py-3">Status</th></tr></thead><tbody>
      {report?.items.map((item) => <tr key={item.sku} className="border-t border-zinc-100"><td className="px-4 py-3"><p className="font-bold">{item.sku}</p><p className="text-xs text-zinc-500">{item.name}{item.lastSoldAt ? ` · last sold ${new Date(item.lastSoldAt).toLocaleDateString()}` : ''}</p></td><td className="px-3 py-3 text-right">{number(item.sales30)}</td><td className="px-3 py-3 text-right">{number(item.sales90)}</td><td className="px-3 py-3 text-right font-semibold">{item.minimumStock ? number(item.minimumStock) : '—'}</td><td className="bg-sky-50 px-3 py-3 text-right text-base font-bold text-sky-950">{number(item.localStock)}</td><td className="px-3 py-3 text-right">{number(item.inbound)}</td><td className="px-3 py-3 text-right">{item.daysCover === null ? '—' : number(item.daysCover, 1)}</td><td className="px-3 py-3 text-right">{number(item.reorderPoint)}</td><td className="px-3 py-3 text-right font-bold">{item.suggestedOrder ? number(item.suggestedOrder) : '—'}</td><td className="px-4 py-3"><span className={`inline-flex rounded-full px-2 py-1 text-xs font-bold ${item.status === 'order_now' ? 'bg-red-100 text-red-800' : item.status === 'top_up' ? 'bg-amber-100 text-amber-900' : 'bg-green-100 text-green-800'}`}>{item.status === 'order_now' ? 'Order now' : item.status === 'top_up' ? 'Top up' : 'Covered'}</span></td></tr>)}
      {!loading && !report?.items.length && <tr><td colSpan={10} className="px-4 py-12 text-center text-sm text-zinc-500">No Victron sales or configured stock minimums are available yet.</td></tr>}
      {loading && <tr><td colSpan={10} className="px-4 py-12 text-center text-sm text-zinc-500">Loading replenishment report…</td></tr>}
    </tbody></table></section>
  </div></main>;
}
