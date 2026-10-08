'use client';

import Link from 'next/link';
import { Search } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Company } from './company-access';
import type { AdminUser } from './user-admin';

type XeroPerson = { email: string; name: string; kind: 'primary' | 'additional'; includeInEmails: boolean };
type XeroContact = { id: string; name: string; email: string; people: XeroPerson[] };
type Invitation = { email: string; inviteSent: boolean; userId: number };
type SearchResults = { contacts: XeroContact[]; hasMore: boolean };
type Notice = { companyId: number; text: string; failed: Invitation[]; listRefreshFailed: boolean };

const retryTime = new Intl.DateTimeFormat('en-ZA', {
  timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short',
});

function requestError(response: Response, data: { error?: string }, fallback: string) {
  const retryAfter = response.headers.get('Retry-After');
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  const retryAt = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) : NaN;
  let wait = '';
  if (Number.isFinite(seconds) && seconds > 0) {
    if (seconds < 60) {
      const count = Math.ceil(seconds);
      wait = ` Try again in ${count} ${count === 1 ? 'second' : 'seconds'}.`;
    } else if (seconds < 3600) {
      const count = Math.ceil(seconds / 60);
      wait = ` Try again in ${count} ${count === 1 ? 'minute' : 'minutes'}.`;
    }
    else wait = ` Try again after ${retryTime.format(new Date(Date.now() + seconds * 1000))} SAST.`;
  } else if (Number.isFinite(retryAt)) {
    wait = ` Try again after ${retryTime.format(new Date(retryAt))} SAST.`;
  }
  return new Error(`${data.error || fallback}${wait}`);
}

export function AddCompany({
  companies,
  users,
  defaultDiscount,
  onCreated,
  onOpenCompany,
}: {
  companies: Company[];
  users: AdminUser[];
  defaultDiscount: number;
  onCreated: () => Promise<void>;
  onOpenCompany: () => void;
}) {
  const [searchTerm, setSearchTerm] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [selectedContact, setSelectedContact] = useState<XeroContact | null>(null);
  const [selectedEmails, setSelectedEmails] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const searchRequest = useRef<AbortController | null>(null);

  useEffect(() => () => searchRequest.current?.abort(), []);

  function clearSelection() {
    setSelectedContact(null);
    setSelectedEmails([]);
    setCreateError('');
  }

  function changeSearchTerm(value: string) {
    searchRequest.current?.abort();
    setSearchTerm(value);
    setResults(null);
    setSearching(false);
    setSearchError('');
    clearSelection();
  }

  async function searchXero(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = searchTerm.trim();
    if (query.length < 2) {
      setSearchError('Enter at least two characters to search Xero.');
      return;
    }
    searchRequest.current?.abort();
    const controller = new AbortController();
    searchRequest.current = controller;
    clearSelection();
    setSearching(true);
    setSearchError('');
    setResults(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/xero/contacts?query=${encodeURIComponent(query)}`, {
        cache: 'no-store', signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw requestError(response, data, 'Unable to search Xero contacts.');
      if (!controller.signal.aborted) setResults({ contacts: data.contacts || [], hasMore: Boolean(data.hasMore) });
    } catch (error) {
      if (!controller.signal.aborted) setSearchError(error instanceof Error ? error.message : 'Unable to search Xero contacts.');
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }

  function selectContact(contact: XeroContact) {
    setSelectedContact(contact);
    setSelectedEmails([]);
    setCreateError('');
  }

  function togglePerson(email: string) {
    setSelectedEmails((current) => current.includes(email) ? current.filter((item) => item !== email) : [...current, email]);
  }

  async function createCompany(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedContact) return;
    setCreating(true);
    setCreateError('');
    setNotice(null);
    const formData = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/admin/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          xeroContactId: selectedContact.id,
          selectedPeopleEmails: selectedEmails,
          victronDiscount: Number(formData.get('victronDiscount')),
          renogyDiscount: Number(formData.get('renogyDiscount')),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw requestError(response, data, 'Unable to create company.');
      const invitations = (data.invitations || []) as Invitation[];
      const failed = invitations.filter((invitation) => !invitation.inviteSent);
      const sent = invitations.length - failed.length;
      const text = selectedEmails.length
        ? `${selectedContact.name} was added. ${sent} ${sent === 1 ? 'setup invitation was' : 'setup invitations were'} sent${failed.length ? `; ${failed.length} could not be sent` : ''}.`
        : `${selectedContact.name} was added without buyer access. You can enable people from its company row later.`;
      let listRefreshFailed = false;
      try { await onCreated(); } catch { listRefreshFailed = true; }
      setNotice({ companyId: Number(data.company.id), text, failed, listRefreshFailed });
      setSearchTerm('');
      setResults(null);
      clearSelection();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Unable to create company.');
    } finally {
      setCreating(false);
    }
  }

  const existingByContactId = new Map(companies.filter((company) => company.xero_contact_id).map((company) => [company.xero_contact_id, company]));
  const userByEmail = new Map(users.map((user) => [user.email.toLowerCase(), user]));
  const selectedExistingCompany = selectedContact ? existingByContactId.get(selectedContact.id) : null;
  const people = selectedContact ? [...new Map((selectedContact.people || []).filter((person) => person.email).map((person) => {
    const email = person.email.trim().toLowerCase();
    return [email, { ...person, email }] as const;
  })).values()] : null;

  return <section id="add-company" className="mb-6 scroll-mt-6">
    <h2 className="text-lg font-bold">Add a company</h2>
    <p className="mb-4 mt-1 text-sm text-zinc-600">Search Xero by company name or primary contact email, then choose the people who should have Store buyer access. Each search checks Xero for current details.</p>
    {notice && <div role="status" className={`mb-4 rounded-md border p-3 text-sm ${notice.failed.length || notice.listRefreshFailed ? 'border-amber-200 bg-amber-50 text-amber-950' : 'border-green-200 bg-green-50 text-green-900'}`}>
      <p>{notice.text}{!notice.listRefreshFailed && <a href={`#company-${notice.companyId}`} onClick={onOpenCompany} className="ml-2 font-semibold underline">Open company</a>}</p>
      {notice.failed.length > 0 && <p className="mt-1">Resend the setup email from {notice.failed.map((invitation, index) => <span key={invitation.email}>{index > 0 ? ', ' : ''}<Link href={`/admin/users/${invitation.userId}`} className="font-semibold underline">{invitation.email}</Link></span>)}.</p>}
      {notice.listRefreshFailed && <p className="mt-1">The company list could not refresh. Reload this page to see the new company.</p>}
    </div>}
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <form onSubmit={searchXero} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <label className="grid gap-1 text-sm font-semibold">Company name or primary email
          <input value={searchTerm} onChange={(event) => changeSearchTerm(event.target.value)} placeholder="e.g. Chapman Plumbing" autoComplete="off" maxLength={100} disabled={creating} className="h-10 rounded-md border border-zinc-300 px-3 font-normal disabled:opacity-60" />
        </label>
        <button type="submit" disabled={searching || creating} className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-300 px-4 text-sm font-semibold disabled:opacity-60"><Search aria-hidden="true" className="h-4 w-4" />{searching ? 'Searching Xero…' : 'Search Xero'}</button>
      </form>
      {searchError && <p role="alert" className="mt-3 text-sm text-red-700">{searchError}</p>}
      {results && <div className="mt-4 border-t border-zinc-100 pt-4">
        <h3 className="text-sm font-bold">Matching Xero companies</h3>
        {results.contacts.length ? <div className="mt-2 grid gap-2">{results.contacts.map((contact) => {
          const existing = existingByContactId.get(contact.id);
          const active = selectedContact?.id === contact.id;
          return <div key={contact.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 ${active ? 'border-zinc-950 bg-zinc-50' : 'border-zinc-200'}`}>
            <div className="min-w-0"><p className="text-sm font-semibold">{contact.name}</p><p className="break-all text-xs text-zinc-500">{contact.email || 'No primary email'} · Xero ID {contact.id}</p></div>
            {existing ? <a href={`#company-${existing.id}`} onClick={onOpenCompany} className="text-sm font-semibold underline">Already in Store · Open</a> : active ? <span className="inline-flex h-9 items-center rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white">Selected</span> : <button type="button" onClick={() => selectContact(contact)} disabled={creating} className="h-9 rounded-md border border-zinc-300 bg-white px-3 text-sm font-semibold disabled:opacity-60">Select company</button>}
          </div>;
        })}</div> : <p className="mt-2 text-sm text-zinc-600">No Xero contacts matched. Check the name or email in Xero and search again.</p>}
        {results.hasMore && <p className="mt-2 text-xs text-zinc-600">Showing the first results. Use a more specific name or email to narrow the search.</p>}
      </div>}
      {selectedContact && !selectedExistingCompany && <div className="mt-4 border-t border-zinc-100 pt-4">
        <h3 className="text-sm font-bold">Store access for {selectedContact.name}</h3>
        <p className="mt-1 text-xs text-zinc-600">Select up to 20 people to activate and invite now. You can add others later from this company’s row.</p>
        {people && <>
          {people.length ? <div className="mt-3 grid gap-2">{people.map((person) => {
            const existingUser = userByEmail.get(person.email);
            return <div key={person.email} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-200 p-3">
              <label className={`flex min-w-0 items-center gap-3 text-sm ${existingUser ? 'text-zinc-500' : 'cursor-pointer'}`}>
                <input type="checkbox" checked={selectedEmails.includes(person.email)} disabled={Boolean(existingUser) || creating || (selectedEmails.length >= 20 && !selectedEmails.includes(person.email))} onChange={() => togglePerson(person.email)} className="h-4 w-4 shrink-0" />
                <span className="min-w-0"><span className="block font-semibold">{person.name || person.email} <span className="font-normal text-zinc-500">· {person.kind === 'primary' ? 'Primary' : 'Additional'}</span></span><span className="block break-all text-xs">{person.email}</span></span>
              </label>
              {existingUser && <Link href={`/admin/users/${existingUser.id}`} className="text-xs font-semibold underline">Already in Store · Review user</Link>}
            </div>;
          })}</div> : <p className="mt-3 text-sm text-zinc-600">No people with email addresses are available on this Xero contact. You can create the company and add people in Xero later.</p>}
          <form onSubmit={createCompany} className="mt-4 grid gap-3 border-t border-zinc-100 pt-4">
            <div className="flex flex-wrap gap-3"><label className="grid gap-1 text-sm font-semibold">Victron discount (%)<input name="victronDiscount" type="number" min={0} max={40} step="0.01" defaultValue={defaultDiscount} required className="h-10 w-40 rounded-md border border-zinc-300 px-3 font-normal" /></label><label className="grid gap-1 text-sm font-semibold">Renogy discount (%)<input name="renogyDiscount" type="number" min={0} max={40} step="0.01" defaultValue={defaultDiscount} required className="h-10 w-40 rounded-md border border-zinc-300 px-3 font-normal" /></label></div>
            {createError && <p role="alert" className="text-sm text-red-700">{createError}</p>}
            <div><button disabled={creating} className="h-10 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white disabled:opacity-60">{creating ? 'Creating company…' : selectedEmails.length ? `Create company and invite ${selectedEmails.length} ${selectedEmails.length === 1 ? 'person' : 'people'}` : 'Create company without buyers'}</button></div>
          </form>
        </>}
      </div>}
    </div>
  </section>;
}
