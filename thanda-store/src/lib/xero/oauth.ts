import { hubFetch } from './hub.mjs';
const EXCLUDED_ADDITIONAL_PERSON_EMAILS = new Set(['sales@thanda.solar']);
export const XERO_SCOPES = 'offline_access accounting.settings.read accounting.contacts.read accounting.invoices';
export const xeroAccountingFetch = hubFetch;

export type XeroContactMatch = {
  id: string;
  name: string;
  email: string;
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

type XeroContactsResponse = {
  Contacts?: Array<{
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
  }>;
};

function personName(firstName: unknown, lastName: unknown, fallback: string) {
  return [String(firstName || '').trim(), String(lastName || '').trim()].filter(Boolean).join(' ') || fallback;
}

export async function getXeroContactDetails(contactId: string): Promise<XeroContactDetails> {
  const response = await hubFetch(`/Contacts/${encodeURIComponent(contactId)}`);
  const payload = await response.json() as XeroContactsResponse;
  if (!response.ok) throw new Error(`Xero contact fetch failed: ${response.status}`);
  const contact = payload.Contacts?.[0];
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
    .filter((person) => person.email && person.email !== primaryEmail && !EXCLUDED_ADDITIONAL_PERSON_EMAILS.has(person.email));
  const name = String(contact.Name || '').trim();
  if (!name) throw new Error('Xero contact does not have a name');
  return { name, people: [...primary, ...additional] };
}

export async function getXeroContactPeople(contactId: string): Promise<XeroContactPerson[]> {
  return (await getXeroContactDetails(contactId)).people;
}

export async function findXeroContactsByEmail(email: string): Promise<XeroContactMatch[]> {
  const query = new URLSearchParams({
    where: `EmailAddress=="${email}"`,
    summaryOnly: 'true',
    page: '1',
    pageSize: '100',
  });
  const response = await hubFetch(`/Contacts?${query.toString()}`);
  const payload = await response.json() as XeroContactsResponse;
  if (!response.ok) throw new Error(`Xero contact lookup failed: ${response.status}`);

  return (Array.isArray(payload.Contacts) ? payload.Contacts : [])
    .filter((contact) => String(contact.ContactStatus || '').toUpperCase() !== 'ARCHIVED')
    .filter((contact) => String(contact.EmailAddress || '').trim().toLowerCase() === email.toLowerCase())
    .map((contact) => ({
      id: String(contact.ContactID),
      name: String(contact.Name || ''),
      email: String(contact.EmailAddress || ''),
    }))
    .filter((contact) => contact.id && contact.name);
}
