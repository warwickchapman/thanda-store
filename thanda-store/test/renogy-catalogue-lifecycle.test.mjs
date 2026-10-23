import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRenogyCatalogueExport, recordRenogyCatalogueMembership, renogyCatalogueMembershipDetails } from '../src/lib/renogy-catalogue-lifecycle.mjs';

const observedAt = '2026-10-23T10:00:00.000Z';
const header = 'Item No,Item Description,Available,In transit,Expected Delivery Date';

test('a complete Renogy export records membership independently of missing or zero stock', () => {
  const rows = parseRenogyCatalogueExport(`\uFEFF${header}\n rng-current ,Current product,0,0,\nRNG-UNKNOWN,Unknown quantity,,,`, observedAt);
  assert.deepEqual(rows.map(row => row.SKU), ['RNG-CURRENT', 'RNG-UNKNOWN']);
  assert.equal(rows[0].Stock, '0');
  assert.equal(rows[1].Stock, '');
  assert.deepEqual(renogyCatalogueMembershipDetails(rows[0]), { cataloguePresent: true, catalogueObservedAt: observedAt });
  assert.deepEqual(renogyCatalogueMembershipDetails({ source: 'warehouse-csv', stockObservedAt: observedAt }), {});
});

test('empty, malformed, duplicate or unexpected exports cannot retire saved products', async () => {
  for (const csv of ['', header, `${header}\n,No article,0,0,`, `${header}\nRNG-A,One,0,0,\nrng-a,Duplicate,0,0,`,
    'SKU,Description,Stock\nRNG-A,Local file,0', `${header}\nRNG-A,Truncated,0`,
    'Item No,Item Description,Available,Available\nRNG-A,Repeated column,0,0']) {
    assert.throws(() => parseRenogyCatalogueExport(csv, observedAt));
  }
  assert.throws(() => parseRenogyCatalogueExport(`${header}\nRNG-A,One,0,0,`, null));
  const db = { query: async () => assert.fail('Invalid membership must not reach the database.') };
  await assert.rejects(recordRenogyCatalogueMembership(db, [], observedAt));
  await assert.rejects(recordRenogyCatalogueMembership(db, [{ SKU: 'RNG-A', source: 'warehouse-csv', stockObservedAt: observedAt }], observedAt));
});
