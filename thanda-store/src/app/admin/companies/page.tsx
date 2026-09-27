'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CompanyDiscounts, type Company } from '@/components/admin/company-access';
import { XeroContactFields, XeroPeopleAccess, type AdminUser } from '@/components/admin/user-admin';

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [query, setQuery] = useState('');
  const [email, setEmail] = useState('');
  const [contactId, setContactId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [defaultDiscount, setDefaultDiscount] = useState(30);

  async function load() {
    const [companyResponse, userResponse] = await Promise.all([
      fetch('/api/admin/companies', { cache: 'no-store' }), fetch('/api/admin/users', { cache: 'no-store' }),
    ]);
    const [companyData, userData] = await Promise.all([companyResponse.json(), userResponse.json()]);
    if (!companyResponse.ok || !userResponse.ok) throw new Error(companyData.error || userData.error || 'Unable to load companies.');
    setCompanies(companyData.companies); setDefaultDiscount(companyData.defaultDiscount); setUsers(userData.users); setCanManage(companyData.canManageUsers); setLoaded(true);
  }
  useEffect(() => {
    async function loadInitialCompanies() {
      try { await load(); }
      catch (error) { setError(error instanceof Error ? error.message : 'Unable to load companies.'); }
    }
    void loadInitialCompanies();
  }, []);

  async function create(form: HTMLFormElement) {
    setBusy(true); setMessage(''); setError('');
    const data = new FormData(form);
    try {
      const response = await fetch('/api/admin/companies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        xeroContactId: data.get('xeroContactId'), victronDiscount: Number(data.get('victronDiscount')), renogyDiscount: Number(data.get('renogyDiscount')),
      }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to create company.');
      setEmail(''); setContactId(''); form.reset(); await load(); setMessage('Company created. Open its people list to enable access, or invite a user from User Admin.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to create company.'); }
    finally { setBusy(false); }
  }
  const matching = companies.filter((company) => [company.name, company.xero_contact_id].some((value) => value?.toLowerCase().includes(query.trim().toLowerCase())));
  return <main className="min-h-screen bg-zinc-50 text-zinc-950"><div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b pb-4"><div><h1 className="text-2xl font-bold">Companies</h1><p className="mt-1 text-sm text-zinc-600">Manage each company’s Xero contact, pricing and people in one place.</p></div><nav className="flex flex-wrap gap-4 text-sm font-semibold"><Link href="/admin/users">User Admin</Link><Link href="/admin/data-health">Data health</Link><Link href="/">Back to store</Link></nav></header>
    {error && <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}<button type="button" className="ml-3 underline" onClick={() => { setError(''); void load().catch((error) => setError(error instanceof Error ? error.message : 'Unable to load companies.')); }}>Retry</button></div>}
    {message && <p role="status" className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800">{message}</p>}
    <label className="mb-4 grid gap-1 text-sm font-semibold">Search companies<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Company name or Xero contact ID" className="h-10 rounded border bg-white px-3 font-normal" /></label>
    <div className="space-y-4">{matching.map((company) => {
      const people = users.filter((user) => Number(user.organisation_id) === Number(company.id));
      return <section id={`company-${company.id}`} key={company.id} className="scroll-mt-4 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm sm:p-5"><div className="flex flex-wrap justify-between gap-3"><div><h2 className="text-lg font-bold">{company.name}</h2><p className="mt-1 break-all text-xs text-zinc-500">{company.xero_contact_id ? `Xero contact: ${company.xero_contact_id}` : 'No Xero contact — staff or unlinked account group'}</p></div><span className="text-sm text-zinc-500">{people.length} {people.length === 1 ? 'user' : 'users'}</span></div>
        {company.xero_contact_id && (canManage ? <CompanyDiscounts key={company.id} company={company} onChanged={load} /> : <p className="my-4 text-sm">Victron {company.discounts.victron ?? 30}% · Renogy {company.discounts.renogy ?? 30}% company discounts</p>)}
        <div className="border-t border-zinc-100 pt-3"><h3 className="mb-2 text-sm font-bold">Portal users</h3>{people.length ? <ul className="divide-y divide-zinc-100">{people.map((user) => <li key={user.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"><div className="min-w-0"><p className="break-all font-medium">{user.email}</p><p className="text-xs text-zinc-500">{user.role === 'admin' ? 'Administrator' : 'Buyer'} · {user.is_active ? 'Active' : 'Disabled'}{user.api_enabled ? ' · API enabled' : ''}</p></div><Link href={`/admin/users/${user.id}`} className="font-semibold underline">{canManage ? 'Edit user' : 'View user'}</Link></li>)}</ul> : <p className="text-sm text-zinc-500">No portal users yet.</p>}</div>
        {canManage && company.xero_contact_id && <XeroPeopleAccess organisationId={Number(company.id)} contactId={company.xero_contact_id} portalUsers={users} onEnabled={load} />}
      </section>;
    })}</div>
    {!loaded && !error && <p className="py-4 text-sm text-zinc-500">Loading companies…</p>}
    {loaded && !matching.length && <p className="py-4 text-sm text-zinc-500">{companies.length ? 'No companies match your search.' : 'No companies yet.'}</p>}
    {canManage && <section className="mt-6 border-t pt-6"><h2 className="text-lg font-bold">Add a company</h2><p className="mb-4 mt-1 text-sm text-zinc-600">Find the primary contact email in the stored Xero catalogue. A company’s Xero identity stays fixed; move individual users if they belong elsewhere.</p><form onSubmit={(event) => { event.preventDefault(); void create(event.currentTarget); }} className="grid gap-3 rounded-lg border bg-white p-4 lg:grid-cols-6">
      <XeroContactFields email={email} emailInput={<label className="grid gap-1 text-sm font-semibold">Primary Xero contact email<input type="email" value={email} onChange={(event) => { setEmail(event.target.value); setContactId(''); }} required className="h-10 rounded border px-3 font-normal" /></label>} onContactSelected={(contact) => setContactId(contact.id)} />
      <div className="flex flex-wrap gap-3 lg:col-span-6"><label className="grid gap-1 text-sm font-semibold">Victron discount (%)<input name="victronDiscount" type="number" min={0} max={40} step="0.01" defaultValue={defaultDiscount} required className="h-10 w-40 rounded border px-3 font-normal" /></label><label className="grid gap-1 text-sm font-semibold">Renogy discount (%)<input name="renogyDiscount" type="number" min={0} max={40} step="0.01" defaultValue={defaultDiscount} required className="h-10 w-40 rounded border px-3 font-normal" /></label></div>
      <button disabled={busy || !contactId} className="h-10 justify-self-start rounded lg:col-span-6 bg-zinc-950 px-4 text-sm font-semibold text-white disabled:opacity-60">{busy ? 'Creating…' : 'Create company'}</button>
    </form></section>}
  </div></main>;
}
