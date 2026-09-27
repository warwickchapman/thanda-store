// Real transactions in an isolated synthetic schema; no Hub, Xero, email or live users.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { createCompany, moveUserCompany, saveCompanyDiscounts, updateUserEmail } from '../src/lib/admin/company-management.mjs';
if (process.env.RUN_COMPANY_DB_TESTS !== '1') throw new Error('Set RUN_COMPANY_DB_TESTS=1 and DATABASE_URL to an isolated PostgreSQL instance.');
const schema = `company_test_${crypto.randomBytes(6).toString('hex')}`;
const config = { connectionString: process.env.DATABASE_URL };
const admin = new pg.Pool(config);
let pool;
const actor = { id: 99, organisationId: 3 };
const contacts = {
  'company-a': { name: 'Company A', people: [{ email: 'a@example.test', kind: 'primary' }, { email: 'new-a@example.test', kind: 'additional' }, { email: 'peer@example.test', kind: 'additional' }] },
  'company-b': { name: 'Company B', people: [{ email: 'new-a@example.test', kind: 'additional' }, { email: 'moved-peer@example.test', kind: 'additional' }] },
  'company-c': { name: 'Company C', people: [] },
};
const getContact = async (id) => { assert.ok(contacts[id]); return contacts[id]; };
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ ...config, options: `-c search_path=${schema}` });
  await pool.query(`CREATE TABLE organisations(id BIGSERIAL PRIMARY KEY,name TEXT,xero_contact_id TEXT UNIQUE,xero_contact_name TEXT);
    CREATE TABLE portal_users(id BIGINT PRIMARY KEY,email TEXT UNIQUE,role TEXT DEFAULT 'buyer',organisation_id BIGINT REFERENCES organisations(id),
      can_manage_users BOOLEAN DEFAULT false,is_active BOOLEAN DEFAULT true,api_enabled BOOLEAN DEFAULT true,xero_person_kind TEXT DEFAULT 'primary',xero_person_email TEXT,updated_at TIMESTAMPTZ);
    CREATE TABLE portal_sessions(user_id BIGINT,token TEXT);
    CREATE TABLE login_otps(user_id BIGINT,consumed_at TIMESTAMPTZ);
    CREATE TABLE account_setup_tokens(user_id BIGINT,consumed_at TIMESTAMPTZ);
    CREATE TABLE portal_api_keys(user_id BIGINT,contact_id TEXT,revoked_at TIMESTAMPTZ);
    CREATE TABLE portal_cart_lines(user_id BIGINT,product_id BIGINT);
    CREATE TABLE contact_supplier_discounts(contact_id TEXT,supplier TEXT,discount_percent NUMERIC,updated_at TIMESTAMPTZ,PRIMARY KEY(contact_id,supplier));
    CREATE TABLE portal_activity_log(user_id BIGINT,organisation_id BIGINT,action TEXT,resource_type TEXT,resource_id TEXT,metadata JSONB);
    INSERT INTO organisations(id,name,xero_contact_id) VALUES(1,'Company A','company-a'),(2,'Company B','company-b'),(3,'Staff',NULL);
    SELECT setval(pg_get_serial_sequence('organisations','id'),3);
    INSERT INTO portal_users(id,email,organisation_id) VALUES(1,'a@example.test',1),(2,'peer@example.test',1),(3,'b@example.test',2),(99,'admin@example.test',3);
    UPDATE portal_users SET role='admin',can_manage_users=true WHERE id=99;
    INSERT INTO contact_supplier_discounts VALUES('company-a','victron',30,now()),('company-a','renogy',20,now()),('company-b','victron',5,now());
    INSERT INTO portal_sessions VALUES(1,'a'),(2,'peer'),(3,'b');
    INSERT INTO login_otps(user_id) VALUES(1),(2),(3);
    INSERT INTO account_setup_tokens(user_id) VALUES(1),(2),(3);
    INSERT INTO portal_api_keys VALUES(1,'company-a',NULL),(2,'company-a',NULL),(3,'company-b',NULL);
    INSERT INTO portal_cart_lines VALUES(1,10),(2,20),(3,30);`);
  const tables = ['organisations', 'portal_users', 'portal_sessions', 'login_otps', 'account_setup_tokens', 'portal_api_keys', 'portal_cart_lines', 'contact_supplier_discounts', 'portal_activity_log'];
  const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async (table) => [table, (await pool.query(`SELECT row_to_json(t) AS row FROM ${table} t ORDER BY row_to_json(t)::text`)).rows.map((r) => r.row)])));
  const userRow = async (id) => (await pool.query('SELECT * FROM portal_users WHERE id=$1', [id])).rows[0];
  const peer = await userRow(2);
  const initial = await snapshot();
  await assert.rejects(() => updateUserEmail(pool, { userId: 1, email: 'outsider@example.test', actor, getContact }), /not an eligible/);
  assert.deepEqual(await snapshot(), initial, 'Invalid email leaves all state untouched');
  await assert.rejects(() => updateUserEmail(pool, { userId: 1, email: 'new-a@example.test', actor, getContact: async () => { throw new Error('Hub unavailable'); } }), /Hub unavailable/);
  assert.deepEqual(await snapshot(), initial, 'Missing stored snapshot fails closed');
  await updateUserEmail(pool, { userId: 1, email: 'NEW-A@EXAMPLE.TEST', actor, getContact });
  let after = await snapshot();
  assert.deepEqual(after.organisations, initial.organisations);
  assert.deepEqual(await userRow(2), peer);
  assert.deepEqual(after.portal_cart_lines, initial.portal_cart_lines);
  assert.equal((await userRow(1)).xero_person_kind, 'additional');
  assert.equal((await pool.query('SELECT 1 FROM portal_sessions WHERE user_id=1')).rowCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM portal_sessions WHERE user_id=2')).rowCount, 1);
  for (const table of ['login_otps', 'account_setup_tokens']) {
    assert.ok((await pool.query(`SELECT consumed_at FROM ${table} WHERE user_id=1`)).rows[0].consumed_at);
    assert.equal((await pool.query(`SELECT consumed_at FROM ${table} WHERE user_id=2`)).rows[0].consumed_at, null);
  }
  const noop = await updateUserEmail(pool, { userId: 1, email: 'new-a@example.test', actor, getContact: async () => { throw new Error('No lookup needed'); } });
  assert.equal(noop.unchanged, true);
  await assert.rejects(() => updateUserEmail(pool, { userId: 1, email: 'peer@example.test', actor, getContact }), /already assigned/);
  const beforeMove = await snapshot();
  await assert.rejects(() => moveUserCompany(pool, { userId: 2, organisationId: 2, actor, getContact }), /not an eligible/);
  await assert.rejects(() => moveUserCompany(pool, { userId: 1, organisationId: 3, actor, getContact }), /Buyers must/);
  assert.deepEqual(await snapshot(), beforeMove);
  await pool.query("INSERT INTO portal_sessions VALUES(1,'new'); UPDATE portal_api_keys SET revoked_at=NULL WHERE user_id=1; UPDATE login_otps SET consumed_at=NULL WHERE user_id=1; UPDATE account_setup_tokens SET consumed_at=NULL WHERE user_id=1");
  await moveUserCompany(pool, { userId: 1, organisationId: 2, actor, getContact });
  assert.equal(Number((await userRow(1)).organisation_id), 2);
  assert.equal((await userRow(1)).api_enabled, false);
  assert.deepEqual(await userRow(2), peer);
  after = await snapshot();
  assert.deepEqual(after.organisations, initial.organisations);
  assert.equal((await pool.query('SELECT 1 FROM portal_cart_lines WHERE user_id=1')).rowCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM portal_cart_lines WHERE user_id=2')).rowCount, 1);
  assert.ok((await pool.query('SELECT revoked_at FROM portal_api_keys WHERE user_id=1')).rows[0].revoked_at);
  assert.equal((await pool.query('SELECT revoked_at FROM portal_api_keys WHERE user_id=2')).rows[0].revoked_at, null);
  for (const table of ['login_otps', 'account_setup_tokens']) assert.ok((await pool.query(`SELECT consumed_at FROM ${table} WHERE user_id=1`)).rows[0].consumed_at);
  await saveCompanyDiscounts(pool, { organisationId: 2, victron: 27, renogy: 19, actor });
  const prices = (await pool.query("SELECT u.id,d.discount_percent FROM portal_users u JOIN organisations o ON o.id=u.organisation_id JOIN contact_supplier_discounts d ON d.contact_id=o.xero_contact_id AND d.supplier='victron' ORDER BY u.id")).rows;
  assert.deepEqual(prices.map((row) => [Number(row.id), Number(row.discount_percent)]), [[1,27],[2,30],[3,27]]);
  await assert.rejects(() => saveCompanyDiscounts(pool, { organisationId: 2, victron: 99, renogy: 19, actor }), /between/);
  // A company and email change is one explicit, validated operation.
  const beforeCombined = await snapshot();
  await assert.rejects(() => moveUserCompany(pool, { userId: 2, organisationId: 2, email: 'new-a@example.test', actor, getContact }), /already assigned/);
  await assert.rejects(() => moveUserCompany(pool, { userId: 2, organisationId: 2, email: 'outsider@example.test', actor, getContact }), /not an eligible/);
  assert.deepEqual(await snapshot(), beforeCombined);
  const firstUser = await userRow(1);
  await moveUserCompany(pool, { userId: 2, organisationId: 2, email: 'MOVED-PEER@EXAMPLE.TEST', actor, getContact });
  assert.equal((await userRow(2)).email, 'moved-peer@example.test');
  assert.equal(Number((await userRow(2)).organisation_id), 2);
  assert.deepEqual(await userRow(1), firstUser);
  assert.deepEqual((await snapshot()).organisations, initial.organisations);
  const created = await createCompany(pool, { contactId: 'company-c', victron: 10, renogy: 20, actor, getContact });
  assert.ok(created.id);
  await assert.rejects(() => createCompany(pool, { contactId: 'company-c', victron: 0, renogy: 0, actor, getContact }), /already has/);
  assert.equal((await pool.query("SELECT discount_percent FROM contact_supplier_discounts WHERE contact_id='company-c' AND supplier='victron'")).rows[0].discount_percent, '10');
  const self = await updateUserEmail(pool, { userId: 99, email: 'new-admin@example.test', actor, getContact: async () => { throw new Error('Staff must not look up Xero'); } });
  assert.equal(self.signedOut, true);
  assert.equal((await userRow(99)).can_manage_users, true);
  console.log('PASS: shared-company email isolation, invalid/duplicate/Hub-failure rollback, no-op edits, explicit person movement, per-user credential/cart cleanup, company-wide pricing and immutable company creation.');
} finally {
  if (pool) await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
