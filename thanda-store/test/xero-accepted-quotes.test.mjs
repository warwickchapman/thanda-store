import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAcceptedQuote } from '../src/lib/xero-accepted-quotes.mjs';

const now = new Date('2026-08-31T12:00:00Z');

function quote(overrides = {}) {
  return {
    QuoteID: 'quote-1',
    QuoteNumber: 'QU-1000',
    Status: 'ACCEPTED',
    DateString: '2026-08-20T00:00:00',
    Contact: { ContactID: 'contact-1', Name: 'Example customer' },
    Reference: 'Customer order',
    LineItems: [
      { LineItemID: 'line-1', ItemCode: 'PMP482305012R', Description: 'Victron inverter Retail', Quantity: 2 },
    ],
    ...overrides,
  };
}

test('current accepted quote lines are eligible reservations', () => {
  const result = normalizeAcceptedQuote(quote(), { now, reservationDays: 90 });
  assert.equal(result.reservationEligible, true);
  assert.equal(result.exclusionReason, null);
  assert.deepEqual(result.lines.map(({ sku, quantity }) => ({ sku, quantity })), [
    { sku: 'PMP482305012R', quantity: 2 },
  ]);
});

test('RMA references and contacts are excluded from reservations', () => {
  const referenceRma = normalizeAcceptedQuote(quote({ Reference: 'RMA 123 replacement' }), { now, reservationDays: 90 });
  const contactRma = normalizeAcceptedQuote(quote({ Contact: { Name: 'RMA Control Account' } }), { now, reservationDays: 90 });
  assert.equal(referenceRma.exclusionReason, 'rma');
  assert.equal(contactRma.exclusionReason, 'rma');
});

test('old accepted quotes are retained as stale but do not reserve stock', () => {
  const result = normalizeAcceptedQuote(quote({ DateString: '2025-01-01T00:00:00' }), { now, reservationDays: 90 });
  assert.equal(result.reservationEligible, false);
  assert.equal(result.exclusionReason, 'stale');
});

test('comment, zero and fractional stock lines are ignored', () => {
  const result = normalizeAcceptedQuote(quote({
    LineItems: [
      { Description: 'Comment only' },
      { ItemCode: 'FREIGHT', Description: 'Freight', Quantity: 0 },
      { ItemCode: 'SCC123', Description: 'Victron controller', Quantity: 1.9 },
    ],
  }), { now, reservationDays: 90 });
  assert.deepEqual(result.lines, []);
});
