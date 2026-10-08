import { hubFetch, hubRequest } from './hub.mjs';
const EXCLUDED_ADDITIONAL_PERSON_EMAILS = new Set(['sales@thanda.solar']);
export const XERO_SCOPES = 'offline_access accounting.settings.read accounting.contacts.read accounting.invoices';
export const xeroAccountingFetch = hubFetch;

export type XeroContactMatch = {
  id: string;
  name: string;
  email: string;
  people: XeroContactPerson[];
};

export type XeroContactPerson = {
  email: string;
  name: string;
  kind: 'primary' | 'additional';
  includeInEmails: boolean;
};

export type XeroContactDetails = {
  name: string;
  people: XeroContactPerson[];
};

type XeroContact = {
    ContactID?: string;
    ContactStatus?: string;
    Name?: string;
    EmailAddress?: string;
    FirstName?: string;
    LastName?: string;
    ContactPersons?: Array<{
      FirstName?: string;
      LastName?: string;
      EmailAddress?: string;
      IncludeInEmails?: boolean;
    }>;
};

type XeroContactsResponse = {
  Contacts?: XeroContact[];
  hasMore?: boolean;
};

export class XeroLiveLookupError extends Error {
  status: number;
  retryAfter: string | null;
  constructor(message: string, status: number, retryAfter: string | null = null) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function liveResponse(response: Response): Promise<XeroContactsResponse> {
  if (!response.ok) {
    throw new XeroLiveLookupError(
      response.status === 503 ? 'Xero contact lookup is paused. Please try again after the indicated wait.' : 'Unable to check current Xero contacts.',
      response.status === 503 ? 503 : 502,
      response.headers.get('Retry-After'),
    );
  }
  return response.json() as Promise<XeroContactsResponse>;
}

function personName(firstName: unknown, lastName: unknown, fallback: string) {
  return [String(firstName || '').trim(), String(lastName || '').trim()].filter(Boolean).join(' ') || fallback;
}

function contactDetails(contact: XeroContact | undefined): XeroContactDetails {
  if (!contact || String(contact.ContactStatus || '').toUpperCase() === 'ARCHIVED') {
    throw new Error('Xero contact was not found or is archived');
  }

  const primaryEmail = String(contact.EmailAddress || '').trim().toLowerCase();
  const primary = primaryEmail
    ? [{
      email: primaryEmail,
      name: personName(contact.FirstName, contact.LastName, String(contact.Name || primaryEmail)),
      kind: 'primary' as const,
      includeInEmails: true,
    }]
    : [];
  const seen = new Set(primary.map((person) => person.email));
  const additional = (contact.ContactPersons || [])
    .map((person) => {
      const email = String(person.EmailAddress || '').trim().toLowerCase();
      return {
        email,
        name: personName(person.FirstName, person.LastName, email),
        kind: 'additional' as const,
        includeInEmails: person.IncludeInEmails === true,
      };
    })
    .filter((person) => {
      if (!person.email || seen.has(person.email) || EXCLUDED_ADDITIONAL_PERSON_EMAILS.has(person.email)) return false;
      seen.add(person.email);
      return true;
    });
  const name = String(contact.Name || '').trim();
  if (!name) throw new Error('Xero contact does not have a name');
  return { name, people: [...primary, ...additional] };
}

export async function getXeroContactDetails(contactId: string): Promise<XeroContactDetails> {
  const response = await hubFetch(`/Contacts/${encodeURIComponent(contactId)}`);
  const payload = await response.json() as XeroContactsResponse;
  if (!response.ok) throw new Error(`Xero contact fetch failed: ${response.status}`);
  return contactDetails(payload.Contacts?.[0]);
}

export async function getLiveXeroContactDetails(contactId: string): Promise<XeroContactDetails> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contactId)) {
    throw new XeroLiveLookupError('Select a valid Xero contact.', 400);
  }
  const payload = await liveResponse(await hubRequest(`live/contacts/${encodeURIComponent(contactId)}`, { signal: AbortSignal.timeout(60_000) }));
  return contactDetails(payload.Contacts?.[0]);
}

export async function getXeroContactPeople(contactId: string): Promise<XeroContactPerson[]> {
  return (await getXeroContactDetails(contactId)).people;
}

export async function findLiveXeroContacts(query: string): Promise<{ contacts: XeroContactMatch[]; hasMore: boolean }> {
  const params = new URLSearchParams({ searchTerm: query });
  const payload = await liveResponse(await hubRequest(`live/contacts?${params.toString()}`, { signal: AbortSignal.timeout(60_000) }));
  const contacts = (Array.isArray(payload.Contacts) ? payload.Contacts : [])
    .filter((contact) => String(contact.ContactStatus || '').toUpperCase() !== 'ARCHIVED')
    .filter((contact) => contact.ContactID && String(contact.Name || '').trim())
    .map((contact) => ({
      id: String(contact.ContactID).toLowerCase(),
      name: String(contact.Name).trim(),
      email: String(contact.EmailAddress || '').trim().toLowerCase(),
      people: contactDetails(contact).people,
    }));
  return { contacts, hasMore: payload.hasMore === true };
}
