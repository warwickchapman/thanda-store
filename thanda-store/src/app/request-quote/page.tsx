import type { Metadata } from 'next';
import { publicFeaturedProducts } from '@/lib/commerce/public-storefront';
import { GuestQuoteForm } from '@/components/guest-quote-form';

export const metadata: Metadata = { title: 'Request a quote · Thanda Solar', description: 'Choose your products and ask the local Thanda team for a quote. No account needed.', robots: { index: false, follow: true } };
export const dynamic = 'force-dynamic';

export default async function RequestQuotePage({ searchParams }: { searchParams: Promise<{ product?: string | string[]; quantity?: string }> }) {
  const query = await searchParams;
  const requested = (Array.isArray(query.product) ? query.product : [query.product]).filter(Boolean).map(Number);
  const products = await publicFeaturedProducts().catch(() => null);
  if (!products) {
    return <main className="mx-auto w-full max-w-3xl space-y-4 px-6 py-16"><p className="text-sm font-semibold uppercase tracking-widest text-amber-700">Thanda Solar · KZN</p><h1 className="text-3xl font-bold">Let’s help you get the right equipment.</h1><p className="text-zinc-600">The product form is temporarily unavailable. Our team can still help with pricing, stock and delivery.</p><a href="mailto:sales@thanda.solar" className="inline-block rounded-lg bg-zinc-900 px-5 py-3 font-semibold text-white">Email sales@thanda.solar</a><p><a href="tel:+27656912951" className="underline">Call +27 65 691 2951</a></p></main>;
  }
  return <GuestQuoteForm products={products} initialIds={requested} initialQuantity={Math.max(1, Math.min(100, Number(query.quantity) || 1))} />;
}
