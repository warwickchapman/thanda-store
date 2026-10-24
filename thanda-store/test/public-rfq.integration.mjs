// Disposable PostgreSQL schema only. No supplier, Hub, Xero or real email calls.
// RUN_PUBLIC_RFQ_DB_TESTS=1 DATABASE_URL=<synthetic test database> node test/public-rfq.integration.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { ensurePublicRfqSchema, normalizeRfq, normalizeRfqInput, recordPublicRfq, resumePublicRfq, RfqError } from '../src/lib/commerce/public-rfq.mjs';
import { runNotifications } from '../src/lib/commerce/notifications.mjs';

if (process.env.RUN_PUBLIC_RFQ_DB_TESTS !== '1' || !process.env.DATABASE_URL) {
  throw new Error('Set RUN_PUBLIC_RFQ_DB_TESTS=1 and DATABASE_URL to a disposable synthetic PostgreSQL database.');
}

const products = [{ id: 1, supplier: 'victron', sku: 'PMP482305012', name: 'MultiPlus-II' }];
const enquiry = (overrides = {}) => normalizeRfq({ requestId: crypto.randomUUID(), startedAt: Date.now() - 5000,
  website: '', contact: { name: 'Synthetic customer', email: 'buyer@example.test', town: 'Ballito' },
  deliveryPreference: 'discuss', message: 'Please advise.', lines: [{ productId: 1, quantity: 2 }], ...overrides }, products);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const rateLimited = error => error instanceof RfqError && error.status === 429;

test('guest enquiries persist atomically, resist duplicate and abusive submissions, and queue staff email safely', async t => {
  const schema = `public_rfq_test_${crypto.randomBytes(6).toString('hex')}`;
  const config = { connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 };
  const admin = new pg.Pool(config);
  const pools = [];
  const makePool = () => {
    const pool = new pg.Pool({ ...config, max: 12, options: `-c search_path=${schema}`, application_name: schema });
    pools.push(pool);
    return pool;
  };
  let created = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Real network access is forbidden during synthetic RFQ tests.'); };
  // Deliberately replace inherited provider configuration; every request below is injected.
  process.env.RESEND_API_KEY = 'synthetic-rfq-test-key';
  process.env.SALES_QUOTE_NOTIFICATION_EMAIL = 'synthetic-sales@example.test';
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    const pool = makePool();
    const restarted = makePool();
    await Promise.all([ensurePublicRfqSchema(pool), ensurePublicRfqSchema(pool), ensurePublicRfqSchema(restarted)]);
    assert.equal((await pool.query("SELECT to_regclass('portal_quote_requests') AS name")).rows[0].name, null,
      'Guest enquiries must not create authenticated quote or accounting records.');
    // A separate pre-existing quote queue is a sentinel: guest workers must not drain it.
    await pool.query('CREATE TABLE portal_quote_notifications(id INTEGER PRIMARY KEY,state TEXT); INSERT INTO portal_quote_notifications VALUES(1,\'pending\')');
    const reset = async () => {
      await pool.query('TRUNCATE guest_quote_notifications,guest_quote_requests,guest_quote_rate_limits RESTART IDENTITY');
      await pool.query("UPDATE portal_notification_state SET next_allowed_at=NULL,last_response='{}'::jsonb");
    };
    const count = async table => Number((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
    const counter = async bucket => (await pool.query('SELECT requests FROM guest_quote_rate_limits WHERE bucket=$1', [bucket])).rows[0]?.requests;
    const due = () => pool.query('UPDATE guest_quote_notifications SET next_attempt_at=now()');
    const worker = (fetcher, maxCalls = 20) => runNotifications(pool, { queue: 'guest', fetcher, pause: async () => {}, maxCalls });

    await t.test('concurrent retries and a new pool preserve one ledger, one sales notification and one allowance charge', async () => {
      await reset();
      const rfq = enquiry();
      const receipts = await Promise.all(Array.from({ length: 8 }, () => recordPublicRfq(pool, rfq, 'same-client')));
      receipts.push(await recordPublicRfq(restarted, rfq, 'different-client'));
      for (const receipt of receipts) assert.deepEqual(receipt, { reference: rfq.id, status: 'received' });
      assert.equal(await count('guest_quote_requests'), 1);
      assert.equal(await count('guest_quote_notifications'), 1);
      assert.equal(await counter('ip:same-client'), 1);
      assert.equal(await counter(`email:${digest(rfq.contact.email)}`), 1);
      assert.equal(await counter('global'), 1);
      assert.equal(await counter('ip:different-client'), undefined);
      const notice = (await pool.query('SELECT audience,email_payload,state FROM guest_quote_notifications')).rows[0];
      assert.equal(notice.audience, 'sales');
      assert.equal(notice.state, 'pending');
      assert.equal(notice.email_payload.to, 'synthetic-sales@example.test');
      assert.doesNotMatch(JSON.stringify(receipts), /buyer@example.test|Synthetic customer|PMP482305012/);
    });

    await t.test('a reused reference with changed details conflicts without overwriting or re-notifying', async () => {
      await reset();
      const rfq = enquiry();
      await recordPublicRfq(pool, rfq, 'same-client');
      await assert.rejects(() => recordPublicRfq(restarted, { ...rfq, message: 'Changed details.' }, 'same-client'),
        error => error instanceof RfqError && error.status === 409);
      assert.equal((await pool.query('SELECT message FROM guest_quote_requests WHERE id=$1', [rfq.id])).rows[0].message, rfq.message);
      assert.equal(await count('guest_quote_notifications'), 1);
      assert.equal(await counter('global'), 1);
    });

    await t.test('saved requests replay by original client identity after server product titles or snapshots change', async () => {
      await reset();
      const rfq = enquiry();
      await recordPublicRfq(pool, rfq, 'original-client');
      const renamed = { ...rfq, lines: rfq.lines.map(line => ({ ...line,
        name: 'Revised catalogue title', sku: 'PMP482305014', supplier: 'changed-server-snapshot' })) };
      assert.deepEqual(await recordPublicRfq(restarted, renamed, 'retry-client'), { reference: rfq.id, status: 'received' });
      const input = normalizeRfqInput({ requestId: rfq.id, startedAt: Date.now() - 2 * 86_400_000,
        website: '', contact: rfq.contact, deliveryPreference: rfq.deliveryPreference, message: rfq.message,
        lines: rfq.lines.map(line => ({ productId: line.productId, quantity: line.quantity })) }, { checkTiming: false });
      assert.deepEqual(await resumePublicRfq(restarted, input), { reference: rfq.id, status: 'received' });
      assert.equal(await resumePublicRfq(restarted, { ...input, id: crypto.randomUUID() }), null);
      await assert.rejects(() => resumePublicRfq(restarted, { ...input,
        lines: input.lines.map(line => ({ ...line, quantity: line.quantity + 1 })) }),
      error => error instanceof RfqError && error.status === 409);
      assert.deepEqual((await pool.query('SELECT lines FROM guest_quote_requests WHERE id=$1', [rfq.id])).rows[0].lines, rfq.lines,
        'The original staff snapshot must survive a retry after catalogue changes.');
      assert.equal(await count('guest_quote_requests'), 1);
      assert.equal(await count('guest_quote_notifications'), 1);
      assert.equal(await counter('global'), 1);
      assert.equal(await counter('ip:retry-client'), undefined);
    });

    await t.test('quotes and SQL-looking customer content are stored as data, without executing it', async () => {
      await reset();
      const text = "O'Brien'; DROP TABLE guest_quote_requests; --";
      const rfq = enquiry({ contact: { name: text, email: 'sql-fixture@example.test', town: 'Ballito', company: text }, message: text });
      await recordPublicRfq(pool, rfq, 'sql-fixture');
      const stored = (await pool.query('SELECT contact,message,lines FROM guest_quote_requests WHERE id=$1', [rfq.id])).rows[0];
      assert.deepEqual(stored.contact, rfq.contact);
      assert.equal(stored.message, text);
      assert.deepEqual(stored.lines, rfq.lines);
      assert.equal(await count('guest_quote_requests'), 1);
      const payload = (await pool.query('SELECT email_payload FROM guest_quote_notifications')).rows[0].email_payload;
      assert.equal(payload.to, 'synthetic-sales@example.test');
      assert.ok(payload.text.includes(text));
    });

    await t.test('a general solution enquiry persists its message with no invented product or accounting record', async () => {
      await reset();
      const rfq = enquiry({ lines: [], message: 'Please advise on LoRa tank monitoring.' });
      await recordPublicRfq(pool, rfq, 'general-enquiry-client');
      const stored = (await pool.query('SELECT message,lines FROM guest_quote_requests WHERE id=$1', [rfq.id])).rows[0];
      assert.deepEqual(stored.lines, []);
      assert.equal(stored.message, rfq.message);
      assert.equal(await count('guest_quote_notifications'), 1);
      assert.equal((await pool.query("SELECT to_regclass('portal_quote_requests') AS name")).rows[0].name, null);
    });

    await t.test('an outbox insert failure rolls back the enquiry and all counters, then permits a clean retry', async () => {
      await reset();
      const rfq = enquiry();
      await pool.query(`CREATE FUNCTION fail_guest_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic outbox failure'; END; $$;
        CREATE TRIGGER fail_guest_outbox BEFORE INSERT ON guest_quote_notifications FOR EACH ROW EXECUTE FUNCTION fail_guest_outbox()`);
      try {
        await assert.rejects(() => recordPublicRfq(pool, rfq, 'rollback-client'), /synthetic outbox failure/);
        assert.equal(await count('guest_quote_requests'), 0);
        assert.equal(await count('guest_quote_notifications'), 0);
        assert.equal(await count('guest_quote_rate_limits'), 0);
      } finally {
        await pool.query('DROP TRIGGER fail_guest_outbox ON guest_quote_notifications; DROP FUNCTION fail_guest_outbox()');
      }
      assert.deepEqual(await recordPublicRfq(restarted, rfq, 'rollback-client'), { reference: rfq.id, status: 'received' });
      assert.equal(await count('guest_quote_notifications'), 1);
      assert.equal(await counter('global'), 1);
    });

    await t.test('concurrent email limits persist across pools and idempotent replay remains possible after the cap', async () => {
      await reset();
      const candidates = Array.from({ length: 9 }, () => enquiry());
      const outcomes = await Promise.allSettled(candidates.map(rfq => recordPublicRfq(pool, rfq, 'email-limit')));
      assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 5);
      for (const result of outcomes.filter(result => result.status === 'rejected')) assert.ok(rateLimited(result.reason));
      assert.equal(await count('guest_quote_requests'), 5);
      assert.equal(await count('guest_quote_notifications'), 5);
      assert.equal(await counter(`email:${digest(candidates[0].contact.email)}`), 5);
      assert.equal(await counter('ip:email-limit'), 5);
      assert.equal(await counter('global'), 5);
      const accepted = candidates[outcomes.findIndex(result => result.status === 'fulfilled')];
      assert.deepEqual(await recordPublicRfq(restarted, accepted, 'email-limit'), { reference: accepted.id, status: 'received' });
      await assert.rejects(() => recordPublicRfq(restarted, enquiry(), 'email-limit'), rateLimited);
      assert.equal(await count('guest_quote_notifications'), 5);
      assert.equal(await counter('global'), 5);
    });

    await t.test('IP and global limits remain bounded under concurrent independent identities', async () => {
      await reset();
      const candidates = Array.from({ length: 15 }, (_, index) => enquiry({ contact: {
        name: `Synthetic customer ${index}`, email: `ip-limit-${index}@example.test`, town: 'Ballito' } }));
      const outcomes = await Promise.allSettled(candidates.map(rfq => recordPublicRfq(pool, rfq, 'shared-ip')));
      assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 10);
      for (const result of outcomes.filter(result => result.status === 'rejected')) assert.ok(rateLimited(result.reason));
      assert.equal(await count('guest_quote_requests'), 10);
      assert.equal(await counter('ip:shared-ip'), 10);
      assert.equal(await counter('global'), 10);
      await reset();
      await pool.query("INSERT INTO guest_quote_rate_limits(bucket,window_start,requests) VALUES('global',now(),99)");
      const global = await Promise.allSettled([0, 1].map(index => recordPublicRfq(pool,
        enquiry({ contact: { name: `Global fixture ${index}`, email: `global-${index}@example.test`, town: 'Ballito' } }), `global-${index}`)));
      assert.equal(global.filter(result => result.status === 'fulfilled').length, 1);
      assert.ok(rateLimited(global.find(result => result.status === 'rejected').reason));
      assert.equal(await counter('global'), 100);
      assert.equal(await count('guest_quote_requests'), 1);
      assert.equal(await count('guest_quote_notifications'), 1);
    });

    await t.test('the guest worker respects its call budget, polls delivery and never drains authenticated quotes', async () => {
      await reset();
      const first = enquiry();
      const second = enquiry();
      await recordPublicRfq(pool, first, 'notification-client');
      await recordPublicRfq(pool, second, 'notification-client');
      const sent = [], checked = [];
      const fetcher = async (url, init) => {
        assert.match(url, /^https:\/\/api\.resend\.com\/emails(?:\/[a-f0-9-]+)?$/);
        assert.equal(init.headers.Authorization, 'Bearer synthetic-rfq-test-key');
        if (init.method === 'POST') {
          const payload = JSON.parse(init.body);
          assert.equal(payload.to, 'synthetic-sales@example.test');
          sent.push({ key: init.headers['Idempotency-Key'], payload });
          return Response.json({ id: crypto.randomUUID() });
        }
        assert.equal(init.method, 'GET');
        checked.push(url);
        return Response.json({ last_event: 'delivered' });
      };
      assert.equal((await worker(fetcher, 0)).calls, 0);
      assert.equal((await worker(fetcher, 1)).calls, 1);
      assert.equal(sent.length, 1);
      assert.equal((await worker(fetcher, 1)).calls, 1);
      assert.equal(sent.length, 2);
      assert.deepEqual(sent.map(item => item.key).sort(), [first.id, second.id].map(id => `guest-rfq-${id}-sales`).sort());
      assert.equal((await pool.query("SELECT count(*)::int n FROM guest_quote_notifications WHERE state='accepted'")).rows[0].n, 2);
      assert.equal((await worker(fetcher)).calls, 0);
      await due();
      assert.equal((await worker(fetcher, 2)).calls, 2);
      assert.equal(checked.length, 2);
      assert.equal(sent.length, 2);
      assert.equal((await pool.query("SELECT count(*)::int n FROM guest_quote_notifications WHERE state='delivered'")).rows[0].n, 2);
      assert.equal((await pool.query('SELECT state FROM portal_quote_notifications WHERE id=1')).rows[0].state, 'pending');
    });

    await t.test('provider throttling stores a shared cooldown and prevents a second recipient or an early retry', async () => {
      await reset();
      await recordPublicRfq(pool, enquiry(), 'cooldown-client');
      await recordPublicRfq(pool, enquiry(), 'cooldown-client');
      let calls = 0;
      const before = Date.now();
      assert.equal((await worker(async () => {
        calls++;
        return Response.json({ name: 'rate_limit_exceeded' }, { status: 429, headers: { 'Retry-After': '120' } });
      })).calls, 1);
      assert.equal(calls, 1);
      const state = (await pool.query('SELECT next_allowed_at,last_response FROM portal_notification_state')).rows[0];
      assert.ok(new Date(state.next_allowed_at).getTime() >= before + 119_000);
      assert.equal(state.last_response.status, 429);
      assert.equal(state.last_response['retry-after'], '120');
      await due();
      assert.equal((await worker(async () => { calls++; throw new Error('Must not call during cooldown.'); })).calls, 0);
      assert.equal(calls, 1);
      assert.equal((await pool.query('SELECT sum(attempts)::int n FROM guest_quote_notifications')).rows[0].n, 1);
    });

    await t.test('an uncertain send retries with its original idempotency key instead of creating another enquiry', async () => {
      await reset();
      const rfq = enquiry();
      await recordPublicRfq(pool, rfq, 'uncertain-client');
      const keys = [];
      assert.equal((await worker(async (_url, init) => { keys.push(init.headers['Idempotency-Key']); throw new Error('Synthetic timeout.'); })).calls, 1);
      await due();
      assert.equal((await worker(async (_url, init) => {
        keys.push(init.headers['Idempotency-Key']);
        return Response.json({ id: crypto.randomUUID() });
      })).calls, 1);
      assert.deepEqual(keys, [`guest-rfq-${rfq.id}-sales`, `guest-rfq-${rfq.id}-sales`]);
      assert.equal(await count('guest_quote_requests'), 1);
      assert.equal(await count('guest_quote_notifications'), 1);
      assert.equal((await pool.query('SELECT state,attempts FROM guest_quote_notifications')).rows[0].state, 'accepted');
    });
  } finally {
    globalThis.fetch = realFetch;
    for (const pool of pools) await pool.end();
    if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
