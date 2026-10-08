import test from 'node:test';
import assert from 'node:assert/strict';
import { findLiveXeroContacts, getLiveXeroContactDetails, XeroLiveLookupError } from '../src/lib/xero/oauth.ts';

const CONTACT_ID = '11111111-1111-4111-8111-111111111111';

test('each explicit lookup reads current Hub live contacts and includes selectable people', async (t) => {
  const previous = { url: process.env.XERO_HUB_URL, token: process.env.XERO_HUB_TOKEN, fetch: global.fetch };
  process.env.XERO_HUB_URL = 'http://hub.test';
  process.env.XERO_HUB_TOKEN = 'test-token';
  t.after(() => {
    global.fetch = previous.fetch;
    for (const [key, value] of [['XERO_HUB_URL', previous.url], ['XERO_HUB_TOKEN', previous.token]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const requests = [];
  let changed = false;
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    if (String(url).endsWith('/live/contacts/' + CONTACT_ID)) {
      return Response.json({ Contacts: [{ ContactID: CONTACT_ID, Name: 'Chapman Plumbing', EmailAddress: 'barry@example.test',
        ContactPersons: [{ EmailAddress: 'new@example.test', FirstName: 'New', LastName: 'Person' }] }] });
    }
    return Response.json({ Contacts: [{ ContactID: CONTACT_ID.toUpperCase(), Name: 'Chapman Plumbing', EmailAddress: 'barry@example.test',
      ContactPersons: [{ EmailAddress: changed ? 'new@example.test' : 'old@example.test' }] }], hasMore: false });
  };

  const first = await findLiveXeroContacts('Chapman');
  changed = true;
  const second = await findLiveXeroContacts('Chapman');
  assert.equal(first.contacts[0].people[1].email, 'old@example.test');
  assert.equal(second.contacts[0].people[1].email, 'new@example.test');
  assert.equal(second.contacts[0].id, CONTACT_ID, 'Contact IDs are canonical for local duplicate checks');
  assert.equal(requests.length, 2, 'Every explicit search makes its own Hub request');
  assert.ok(requests.every((request) => request.url === 'http://hub.test/v1/thanda-solar/live/contacts?searchTerm=Chapman'));
  assert.ok(requests.every((request) => request.options.cache === 'no-store'));

  const details = await getLiveXeroContactDetails(CONTACT_ID);
  assert.deepEqual(details.people.map((person) => [person.email, person.kind]),
    [['barry@example.test', 'primary'], ['new@example.test', 'additional']]);
  assert.equal(requests.length, 3, 'Creation rechecks the selected Contact ID once');
});

test('Hub cooldown returns Retry-After and never uses an older contact result', async (t) => {
  const previous = { url: process.env.XERO_HUB_URL, token: process.env.XERO_HUB_TOKEN, fetch: global.fetch };
  process.env.XERO_HUB_URL = 'http://hub.test';
  process.env.XERO_HUB_TOKEN = 'test-token';
  t.after(() => {
    global.fetch = previous.fetch;
    for (const [key, value] of [['XERO_HUB_URL', previous.url], ['XERO_HUB_TOKEN', previous.token]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  global.fetch = async () => new Response(JSON.stringify({ detail: 'Xero rate limit' }),
    { status: 503, headers: { 'Retry-After': '23' } });
  await assert.rejects(findLiveXeroContacts('Chapman'), (error) =>
    error instanceof XeroLiveLookupError && error.status === 503 && error.retryAfter === '23');
});
