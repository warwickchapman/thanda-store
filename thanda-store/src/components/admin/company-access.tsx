'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export type Company = { id: number; name: string; xero_contact_id: string | null; xero_contact_name: string | null; discounts: Record<string, number>; user_count: number };
type User = { id: number; email: string; role: string; organisation_id: number; organisation_name: string; xero_contact_id: string | null; api_enabled: boolean };

export function ApiAccess({ user, onChanged }: { user: User; onChanged: () => Promise<void> }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(enabled: boolean) {
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/admin/users', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'setApiAccess', userId: Number(user.id), enabled }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to update API access.');
      await onChanged();
      setMessage(enabled ? 'API access enabled. The user can generate their own key.' : 'API access disabled and existing keys revoked.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to update API access.'); }
    finally { setBusy(false); }
  }
  return <section className="my-4 space-y-2"><label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={user.api_enabled} disabled={busy || !user.xero_contact_id} onChange={(event) => void save(event.target.checked)} />Enable API access for this user</label>{!user.xero_contact_id && <p className="text-xs text-zinc-500">API access requires membership of a linked company.</p>}{message && <p role="status" className="text-sm">{message}</p>}</section>;
}

export function CompanyDiscounts({ company, onChanged }: { company: Company; onChanged: () => Promise<void> }) {
  const [victron, setVictron] = useState(String(company.discounts.victron ?? 30));
  const [renogy, setRenogy] = useState(String(company.discounts.renogy ?? 30));
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/admin/companies', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'setDiscounts', organisationId: Number(company.id), victronDiscount: Number(victron), renogyDiscount: Number(renogy) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to save company discounts.');
      await onChanged(); setMessage('Company discounts updated for every user and API key.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to save company discounts.'); }
    finally { setBusy(false); }
  }
  return <section className="my-4 space-y-3"><h3 className="font-bold">Company pricing</h3><p className="text-sm text-zinc-600">Discounts apply to everyone in this company, including API prices.</p><form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <label className="text-sm">Victron discount (%)<input type="number" required min={0} max={40} step="0.01" value={victron} onChange={(event) => setVictron(event.target.value)} className="mt-1 block w-36 rounded border p-2" /></label>
    <label className="text-sm">Renogy discount (%)<input type="number" required min={0} max={40} step="0.01" value={renogy} onChange={(event) => setRenogy(event.target.value)} className="mt-1 block w-36 rounded border p-2" /></label>
    <button disabled={busy} className="rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-60">{busy ? 'Saving…' : 'Save company discounts'}</button>
  </form>{message && <p role="status" className="text-sm">{message}</p>}</section>;
}

export function UserCompany({ user, onChanged }: { user: User; onChanged: () => Promise<void> }) {
  const router = useRouter();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [destination, setDestination] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch('/api/admin/companies', { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to load companies.');
        if (active) setCompanies(data.companies);
      } catch (error) { if (active) setMessage(error instanceof Error ? error.message : 'Unable to load companies.'); }
    }
    void load(); return () => { active = false; };
  }, []);
  async function move(formData: FormData) {
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/admin/users', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'moveCompany', userId: Number(user.id), organisationId: Number(destination), email: formData.get('email') }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to move this user.');
      if (data.signedOut) { router.replace('/login'); return; }
      await onChanged(); setDestination(''); setMessage('User moved. Their sessions and keys were revoked, API access disabled and cart cleared.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to move this user.'); }
    finally { setBusy(false); }
  }
  return <section className="my-4 space-y-3 rounded-lg border border-zinc-200 p-4">
    <div className="flex flex-wrap justify-between gap-2"><div><h3 className="font-bold">Company</h3><p className="text-sm">{user.organisation_name}</p></div><Link href={`/admin/companies#company-${user.organisation_id}`} className="text-sm font-semibold underline">View company and pricing</Link></div>
    <details><summary className="cursor-pointer text-sm font-semibold">Move to another company</summary><p className="my-3 text-sm text-zinc-600">The email below must be an eligible Xero person at the destination company. Moving signs this user out, revokes their keys, disables their API access and clears their cart. Their role and account status stay the same. Other users are unaffected.</p>
      <form onSubmit={(event) => { event.preventDefault(); void move(new FormData(event.currentTarget)); }} className="flex flex-wrap items-end gap-3"><label className="grid min-w-0 flex-1 gap-1 text-sm font-semibold">Destination company<select required value={destination} onChange={(event) => setDestination(event.target.value)} className="h-10 w-full rounded border bg-white px-2 font-normal"><option value="">Select a company</option>{companies.filter((company) => Number(company.id) !== Number(user.organisation_id) && (company.xero_contact_id || user.role === 'admin')).map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label><label className="grid min-w-0 flex-1 gap-1 text-sm font-semibold">Email at destination company<input key={user.email} name="email" type="email" required defaultValue={user.email} className="h-10 w-full rounded border px-2 font-normal" /></label><button disabled={busy || !destination} className="h-10 rounded border px-3 text-sm font-semibold disabled:opacity-60">{busy ? 'Moving…' : 'Move this user'}</button></form>
      <p className="mt-2 text-xs text-zinc-500">If the company is missing, <Link href="/admin/companies" className="underline">create it in Companies</Link> first.</p>
    </details>{message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}
