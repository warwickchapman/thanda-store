import Link from "next/link";

export default async function QuoteConfirmationPage({
  searchParams,
}: {
  searchParams: Promise<{ quoteNumber?: string; reference?: string }>;
}) {
  const { quoteNumber, reference } = await searchParams;

  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-12 sm:px-6">
      <section className="mx-auto max-w-xl rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-amber-700">Quote request received</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-zinc-950">Thank you for your quote request.</h1>
        <div className="mt-6 space-y-3 rounded-xl bg-amber-50 p-5 text-zinc-900">
          <p>Your Xero quote number</p>
          <p className="text-xl font-bold">{quoteNumber || "Pending Xero number"}</p>
          <p className="pt-2">Your reference</p>
          <p className="text-xl font-bold">{reference || "Not supplied"}</p>
        </div>
        <p className="mt-6 text-sm leading-6 text-zinc-600">
          The Thanda sales team will send the final quotation shortly and confirm acceptance with you.
        </p>
        <p className="mt-3 text-sm text-zinc-600">The same confirmation has been sent to your email address.</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/accounts" className="inline-flex h-10 items-center rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800">View accounts</Link>
          <Link href="/" className="inline-flex h-10 items-center rounded-md border border-zinc-300 px-4 text-sm font-semibold text-zinc-900 hover:bg-zinc-50">Continue shopping</Link>
        </div>
      </section>
    </main>
  );
}
