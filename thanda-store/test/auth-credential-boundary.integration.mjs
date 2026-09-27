// Real locks and concurrent transactions in a disposable synthetic schema.
// No email, Hub, Xero or production users are involved.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { issueLoginOtp, finishLogin, issueAccountSetupToken, finishAccountSetup } from '../src/lib/auth/login.mjs';
import { issueApiKey, tokenHash } from '../src/lib/commerce/api-keys.mjs';
import { updateUserEmail, moveUserCompany } from '../src/lib/admin/company-management.mjs';

if (process.env.RUN_AUTH_DB_TESTS !== '1') throw new Error('Set RUN_AUTH_DB_TESTS=1 and DATABASE_URL to an isolated PostgreSQL instance.');
const schema = `auth_test_${crypto.randomBytes(6).toString('hex')}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const pools = [];
const releaseGates = [];
const makePool = (label) => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}`, application_name: `${schema}_${label}` });
  pools.push(pool);
  return pool;
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  releaseGates.push(() => resolve());
  return { promise, resolve };
};
function gateQuery(pool, pattern) {
  const entered = deferred();
  const proceed = deferred();
  return { entered: entered.promise, release: proceed.resolve, pool: {
    query: (...args) => pool.query(...args),
    connect: async () => {
      const db = await pool.connect();
      return { release: () => db.release(), query: async (...args) => {
        if (pattern.test(String(args[0]))) { entered.resolve(); await proceed.promise; }
        return db.query(...args);
      } };
    },
  } };
}
async function waitForBlocked(label, count = 1) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const { rows } = await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [`${schema}_${label}`]);
    if (rows[0].n >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${count} ${label} transaction(s) to wait on the real user lock`);
}
const expected = { userId: 1, email: 'old@example.test', organisationId: 1, passwordHash: 'original-password-hash' };
const apiUser = { id: 1, email: expected.email, organisationId: 1, xeroContactId: 'company-a' };
const actor = { id: 99, organisationId: 3 };
const contact = { name: 'Synthetic company', people: [
  { email: 'old@example.test', kind: 'primary' }, { email: 'new@example.test', kind: 'additional' },
] };
const getContact = async () => contact;
let pool;
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = makePool('normal');
  const auth = makePool('auth');
  const companies = makePool('companies');
  await pool.query(`CREATE TABLE organisations(id BIGINT PRIMARY KEY,name TEXT,xero_contact_id TEXT,xero_contact_name TEXT);
    CREATE TABLE portal_users(id BIGINT PRIMARY KEY,email TEXT UNIQUE,organisation_id BIGINT,role TEXT DEFAULT 'buyer',is_active BOOLEAN DEFAULT true,
      archived_at TIMESTAMPTZ,api_enabled BOOLEAN DEFAULT true,password_hash TEXT,xero_person_kind TEXT,xero_person_email TEXT,updated_at TIMESTAMPTZ);
    CREATE TABLE portal_sessions(user_id BIGINT,session_hash TEXT,expires_at TIMESTAMPTZ);
    CREATE TABLE login_otps(id BIGSERIAL PRIMARY KEY,user_id BIGINT,otp_hash TEXT,created_at TIMESTAMPTZ DEFAULT now(),expires_at TIMESTAMPTZ,consumed_at TIMESTAMPTZ,attempts INT DEFAULT 0);
    CREATE TABLE account_setup_tokens(user_id BIGINT,token_hash TEXT UNIQUE,created_at TIMESTAMPTZ DEFAULT now(),expires_at TIMESTAMPTZ,consumed_at TIMESTAMPTZ);
    CREATE TABLE portal_api_keys(id UUID,user_id BIGINT,contact_id TEXT,name TEXT,token_hash TEXT,prefix TEXT,revoked_at TIMESTAMPTZ);
    CREATE TABLE portal_cart_lines(user_id BIGINT,product_id BIGINT);
    CREATE TABLE portal_activity_log(user_id BIGINT,organisation_id BIGINT,action TEXT,resource_type TEXT,resource_id TEXT,metadata JSONB);
    INSERT INTO organisations VALUES(1,'A','company-a','A'),(2,'B','company-b','B'),(3,'Staff',NULL,NULL);
    INSERT INTO portal_users(id,email,organisation_id,password_hash) VALUES(1,'old@example.test',1,'original-password-hash');`);
  async function reset() {
    await pool.query(`TRUNCATE portal_sessions,login_otps,account_setup_tokens,portal_api_keys,portal_cart_lines,portal_activity_log;
      UPDATE portal_users SET email='old@example.test',organisation_id=1,api_enabled=true,is_active=true,archived_at=NULL,password_hash='original-password-hash' WHERE id=1`);
    await pool.query("INSERT INTO portal_sessions VALUES(1,$1,now()+interval '1 day')", [tokenHash('existing-session')]);
    await pool.query("INSERT INTO login_otps(user_id,otp_hash,expires_at) VALUES(1,$1,now()+interval '10 minutes')", [tokenHash('123456')]);
    await pool.query("INSERT INTO account_setup_tokens(user_id,token_hash,expires_at) VALUES(1,$1,now()+interval '1 day')", [tokenHash('existing-setup')]);
  }
  const count = async (table, where = 'true') => (await pool.query(`SELECT count(*)::int n FROM ${table} WHERE ${where}`)).rows[0].n;
  const move = () => moveUserCompany(companies, { userId: 1, organisationId: 2, actor, getContact });

  await reset();
  const editEntered = deferred(); const releaseEdit = deferred();
  const edit = updateUserEmail(companies, { userId: 1, email: 'new@example.test', actor,
    getContact: async () => { editEntered.resolve(); await releaseEdit.promise; return contact; } });
  await editEntered.promise;
  // These all captured the old identity before the administrator's edit.
  const keyAfterEdit = issueApiKey(auth, { user: apiUser, name: 'racing', sessionToken: 'existing-session' }).catch(error => error);
  const otpAfterEdit = issueLoginOtp(auth, expected);
  const resetAfterEdit = issueAccountSetupToken(auth, expected);
  const loginAfterEdit = finishLogin(auth, expected, '123456');
  const setupAfterEdit = finishAccountSetup(auth, 'existing-setup', async () => 'must-not-save');
  await waitForBlocked('auth', 5);
  releaseEdit.resolve(); await edit;
  const denied = await Promise.all([keyAfterEdit, otpAfterEdit, resetAfterEdit, loginAfterEdit, setupAfterEdit]);
  assert.match(denied[0].message, /account changed/);
  assert.deepEqual(denied.slice(1), [null, null, null, null]);
  assert.equal(await count('portal_api_keys'), 0);
  assert.equal(await count('portal_sessions'), 0);
  assert.equal((await pool.query('SELECT password_hash FROM portal_users WHERE id=1')).rows[0].password_hash, expected.passwordHash);
  console.log('PASS: email edit blocks all in-flight old-identity key, OTP, reset and session issuance.');

  await reset();
  const sessionGate = gateQuery(auth, /INSERT INTO portal_sessions/);
  const login = finishLogin(sessionGate.pool, expected, '123456');
  await sessionGate.entered;
  const movement = move();
  await waitForBlocked('companies');
  sessionGate.release(); assert.ok(await login); await movement;
  assert.equal(await count('portal_sessions'), 0, 'Move must revoke the session created just before it');
  assert.equal(await finishLogin(pool, { ...expected, organisationId: 2 }, '123456'), null);
  console.log('PASS: OTP consumption and session insertion are atomic against a company move.');

  await reset();
  const keyGate = gateQuery(auth, /INSERT INTO portal_api_keys/);
  const keyBeforeEdit = issueApiKey(keyGate.pool, { user: apiUser, name: 'before-edit', sessionToken: 'existing-session' });
  await keyGate.entered;
  const emailEdit = updateUserEmail(companies, { userId: 1, email: 'new@example.test', actor, getContact });
  await waitForBlocked('companies');
  keyGate.release(); await keyBeforeEdit; await emailEdit;
  assert.equal(await count('portal_api_keys', 'revoked_at IS NULL'), 0);
  console.log('PASS: keys issued immediately before an email edit are included in revocation.');

  await reset();
  const setupEntered = deferred(); const releaseSetup = deferred();
  const completion = finishAccountSetup(auth, 'existing-setup', async () => {
    setupEntered.resolve(); await releaseSetup.promise; return 'new-password-hash';
  });
  await setupEntered.promise;
  const moveAfterSetup = move();
  await waitForBlocked('companies');
  releaseSetup.resolve(); assert.equal(await completion, expected.email); await moveAfterSetup;
  assert.equal(await finishAccountSetup(pool, 'existing-setup', async () => 'must-not-save'), null);
  assert.equal(await count('login_otps', 'consumed_at IS NULL'), 0);
  console.log('PASS: setup completion uses user-before-token locks without a move deadlock or reusable credential.');

  await reset();
  await pool.query('DELETE FROM portal_sessions');
  const attempts = await Promise.all([finishLogin(auth, expected, '123456'), finishLogin(auth, expected, '123456')]);
  assert.equal(attempts.filter(Boolean).length, 1);
  assert.equal(await count('portal_sessions'), 1);
  assert.equal(await finishLogin(auth, expected, '123456'), null);
  console.log('PASS: concurrent verification can consume a login code only once.');

  await reset();
  await pool.query('DELETE FROM portal_sessions');
  await assert.rejects(() => issueApiKey(pool, { user: apiUser, name: 'stale-session', sessionToken: 'existing-session' }), /session ended/);
  await pool.query("UPDATE portal_users SET password_hash='changed' WHERE id=1");
  assert.equal(await issueLoginOtp(pool, expected), null);
  await pool.query('UPDATE portal_users SET is_active=false WHERE id=1');
  assert.equal(await issueAccountSetupToken(pool, expected), null);
  assert.equal(await finishAccountSetup(pool, 'existing-setup', async () => 'must-not-save'), null);
  console.log('PASS: stale sessions, changed passwords and disabled accounts cannot issue credentials.');
} finally {
  releaseGates.forEach((release) => release());
  await Promise.all(pools.map((entry) => entry.end()));
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
