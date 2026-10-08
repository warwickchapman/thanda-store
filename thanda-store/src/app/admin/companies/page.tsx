'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { CompanyDiscounts, type Company } from '@/components/admin/company-access';
import { XeroPeopleAccess, type AdminUser } from '@/components/admin/user-admin';
import { AddCompany } from '@/components/admin/add-company';
import { AdminMenu } from '@/components/admin/admin-menu';

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
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
  useEffect(() => {
    if (!loaded) return;
    function openLinkedCompany() {
      const id = window.location.hash.slice(1);
      if (!/^company-\d+$/.test(id)) return;
      const row = document.getElementById(id);
      if (row instanceof HTMLDetailsElement) {
        row.open = true;
        row.scrollIntoView({ block: 'start' });
      }
    }
    openLinkedCompany();
    window.addEventListener('hashchange', openLinkedCompany);
    return () => window.removeEventListener('hashchange', openLinkedCompany);
  }, [loaded, query]);

  const matching = companies.filter((company) => [company.name, company.xero_contact_id].some((value) => value?.toLowerCase().includes(query.trim().toLowerCase())));
  return <main className="min-h-screen bg-zinc-50 text-zinc-950"><div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b pb-4"><div><h1 className="text-2xl font-bold">Companies</h1><p className="mt-1 text-sm text-zinc-600">Manage each company’s Xero contact, pricing and people in one place.</p></div><AdminMenu /></header>
    {error && <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}<button type="button" className="ml-3 underline" onClick={() => { setError(''); void load().catch((error) => setError(error instanceof Error ? error.message : 'Unable to load companies.')); }}>Retry</button></div>}
    {canManage && <AddCompany companies={companies} users={users} defaultDiscount={defaultDiscount} onCreated={async () => { setQuery(''); await load(); }} onOpenCompany={() => setQuery('')} />}
    <label className="mb-4 grid gap-1 text-sm font-semibold">Search companies<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Company name or Xero contact ID" className="h-10 rounded border bg-white px-3 font-normal" /></label>
    <div className="divide-y divide-zinc-200 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">{matching.map((company) => {
      const people = users.filter((user) => Number(user.organisation_id) === Number(company.id));
      return <details id={`company-${company.id}`} key={company.id} className="group scroll-mt-4"><summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-zinc-950 [&::-webkit-details-marker]:hidden"><span className="min-w-0 flex-1 truncate font-semibold" title={company.name}>{company.name}</span>{company.xero_contact_id && <span className="hidden shrink-0 text-sm text-zinc-500 sm:inline">Victron {company.discounts.victron ?? 30}% · Renogy {company.discounts.renogy ?? 30}%</span>}<span className="shrink-0 text-sm text-zinc-500">{people.length} {people.length === 1 ? 'user' : 'users'}</span><ChevronDown aria-hidden="true" size={18} className="shrink-0 text-zinc-500 transition-transform group-open:rotate-180" /></summary><div className="border-t border-zinc-100 px-4 pb-4 pt-3 sm:px-5"><p className="mb-3 break-all text-xs text-zinc-500">{company.xero_contact_id ? `Xero contact: ${company.xero_contact_id}` : 'No Xero contact — staff or unlinked account group'}</p>
        {company.xero_contact_id && (canManage ? <CompanyDiscounts key={company.id} company={company} onChanged={load} /> : <p className="my-4 text-sm">Victron {company.discounts.victron ?? 30}% · Renogy {company.discounts.renogy ?? 30}% company discounts</p>)}
        <div className="border-t border-zinc-100 pt-3"><h3 className="mb-2 text-sm font-bold">Portal users</h3>{people.length ? <ul className="divide-y divide-zinc-100">{people.map((user) => <li key={user.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"><div className="min-w-0"><p className="break-all font-medium">{user.email}</p><p className="text-xs text-zinc-500">{user.role === 'admin' ? 'Administrator' : 'Buyer'} · {user.is_active ? 'Active' : 'Disabled'}{user.api_enabled ? ' · API enabled' : ''}</p></div><Link href={`/admin/users/${user.id}`} className="font-semibold underline">{canManage ? 'Edit user' : 'View user'}</Link></li>)}</ul> : <p className="text-sm text-zinc-500">No portal users yet.</p>}</div>
        {canManage && company.xero_contact_id && <XeroPeopleAccess organisationId={Number(company.id)} contactId={company.xero_contact_id} portalUsers={users} onEnabled={load} />}
      </div></details>;
    })}</div>
    {!loaded && !error && <p className="py-4 text-sm text-zinc-500">Loading companies…</p>}
    {loaded && !matching.length && <p className="py-4 text-sm text-zinc-500">{companies.length ? 'No companies match your search.' : 'No companies yet.'}</p>}
  </div></main>;
}
