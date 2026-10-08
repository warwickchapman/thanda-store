import assert from 'node:assert/strict';
import test from 'node:test';
import { contactObservedAt, usersRemovedByContact } from '../src/lib/xero/contact-reconciliation.mjs';

test('stored contact evidence cannot revoke a buyer created after live Xero verification', () => {
  const oldSnapshot = contactObservedAt({ _hub: { observed_at: '2026-10-08T08:00:00Z' } });
  const buyerCreated = new Date('2026-10-08T08:05:00Z');
  const users = [
    { id: 1, xero_person_email: 'barry@chapmanplumbing.co.za', created_at: buyerCreated },
    { id: 2, xero_person_email: 'removed@example.test', created_at: new Date('2026-10-07T08:00:00Z') },
    { id: 3, xero_person_email: 'present@example.test', created_at: new Date('2026-10-07T08:00:00Z') },
  ];
  const storedEmails = new Set(['present@example.test']);
  assert.deepEqual(usersRemovedByContact(users, storedEmails, oldSnapshot), [2]);
  assert.deepEqual(usersRemovedByContact([{ ...users[0], created_at: oldSnapshot }], storedEmails, oldSnapshot), []);

  const refreshedSnapshot = contactObservedAt({ _hub: { observed_at: '2026-10-08T08:10:00Z' } });
  assert.deepEqual(usersRemovedByContact(users, storedEmails, refreshedSnapshot), [1, 2]);
  assert.deepEqual(usersRemovedByContact(users, new Set([...storedEmails, 'barry@chapmanplumbing.co.za']), refreshedSnapshot), [2]);
  assert.deepEqual(usersRemovedByContact([{ id: 4, xero_person_email: 'unknown@example.test' }], storedEmails, refreshedSnapshot), []);
});

test('missing or invalid Hub observation fails closed', () => {
  assert.throws(() => contactObservedAt({ _hub: { observed_at: 'not-a-date' } }), /observation time/);
  assert.throws(() => contactObservedAt({ Contacts: [] }), /observation time/);
});
