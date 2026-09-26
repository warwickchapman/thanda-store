import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth/server';
import { curlExample, csvExample, docsVersion, exampleResponse, guideSections, productProperties, responseStatuses } from '@/lib/commerce/api-documentation.mjs';

export default async function ApiGuidePage() {
  const user = await currentUser();
  if (!user) redirect('/login?next=/api-access/guide');
  if (!user.apiEnabled || !user.xeroContactId) redirect('/api-access');
  return <main className="mx-auto w-full min-w-0 max-w-4xl space-y-8 px-4 py-8 text-zinc-900">
    <header className="space-y-4">
      <Link href="/api-access" className="text-sm underline">Back to API access</Link>
      <div><h1 className="text-3xl font-bold">Customer API guide</h1><p className="mt-2 text-sm text-zinc-500">API v1 · Updated {docsVersion}</p></div>
      <p>Connect your own system to your company prices and recorded stock.</p>
      <div className="flex flex-wrap gap-3">
        <a href="/api/account/api-docs" className="rounded-lg bg-zinc-950 px-4 py-2 text-sm font-semibold text-white">Download OpenAPI JSON</a>
        <a href="/api/account/api-docs?format=markdown" className="rounded-lg border px-4 py-2 text-sm font-semibold">Download guide Markdown</a>
      </div>
      <p className="text-sm text-zinc-600">Give the JSON specification or Markdown guide to your developer or AI assistant. These files contain examples, no API secrets or customer data. Configure your real key separately.</p>
    </header>
    {guideSections.map(section => <section key={section.title} className="space-y-3">
      <h2 className="text-xl font-bold">{section.title}</h2>
      {section.paragraphs.map(p => <p key={p} className="text-sm leading-6 text-zinc-700">{p}</p>)}
      {section.title === 'Get connected' && <div className="space-y-2"><h3 className="font-semibold">Your first request</h3><pre className="overflow-x-auto rounded-lg border bg-zinc-50 p-4 text-xs leading-6"><code>{curlExample}</code></pre></div>}
    </section>)}
    <section className="space-y-3"><h2 className="text-xl font-bold">Example response</h2><p className="text-sm text-zinc-600">Illustrative values, not current prices or stock.</p><pre className="overflow-x-auto rounded-lg border bg-zinc-50 p-4 text-xs leading-6"><code>{JSON.stringify(exampleResponse, null, 2)}</code></pre></section>
    <section className="space-y-3"><h2 className="text-xl font-bold">Product fields</h2><dl className="divide-y rounded-lg border px-4">
      {Object.entries(productProperties).map(([field, schema]) => <div key={field} className="grid gap-2 py-3 sm:grid-cols-[14rem_1fr]"><dt><code className="break-all text-sm font-semibold">{field}</code><span className="block text-xs text-zinc-500">{[schema.type].flat().join(' or ')}</span></dt><dd className="text-sm leading-6 text-zinc-700">{schema.description}</dd></div>)}
    </dl></section>
    <section className="space-y-3"><h2 className="text-xl font-bold">Download a complete CSV</h2><pre className="overflow-x-auto rounded-lg border bg-zinc-50 p-4 text-xs leading-6"><code>{csvExample}</code></pre></section>
    <section className="space-y-3"><h2 className="text-xl font-bold">Responses and recovery</h2><dl className="divide-y rounded-lg border px-4">
      {responseStatuses.map(s => <div key={s.code} className="grid gap-2 py-3 sm:grid-cols-[14rem_1fr]"><dt className="text-sm font-semibold">{s.code} · {s.meaning}</dt><dd className="text-sm leading-6 text-zinc-700">{s.action}</dd></div>)}
    </dl></section>
  </main>;
}
