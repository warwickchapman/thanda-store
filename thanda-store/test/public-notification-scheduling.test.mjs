import assert from 'node:assert/strict';
import test from 'node:test';
import { runNotificationQueues } from '../src/lib/commerce/notifications.mjs';

// Every worker call is injected. Neither real database access nor provider
// requests are permitted by this scheduling suite.
const originalFetch = globalThis.fetch;
let providerRequests = 0;
test.before(() => {
  globalThis.fetch = async () => {
    providerRequests++;
    throw new Error('Real provider requests are forbidden in scheduling tests.');
  };
});
test.after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(providerRequests, 0);
});

function harness({ guestReady = true, elapsedPerCall = 0, idle = [], lookupElapsed = 0 } = {}) {
  const start = 1_000_000;
  let clock = start;
  const invocations = [];
  const queries = [];
  const now = () => clock;
  const pool = {
    query: async sql => {
      queries.push(sql);
      assert.equal(sql, "SELECT to_regclass('guest_quote_notifications') IS NOT NULL AS ready");
      clock += lookupElapsed;
      return { rows: [{ ready: guestReady }] };
    },
    connect: async () => { throw new Error('The injected scheduler must not access a database connection.'); },
  };
  const runner = async (receivedPool, options) => {
    assert.equal(receivedPool, pool);
    assert.equal(options.maxCalls, 1);
    assert.equal(options.now, now);
    assert.equal(options.deadlineAt, start + 45_000, 'Every queue turn must share the original deadline.');
    assert.ok(clock < options.deadlineAt, 'No worker may start at or after the deadline.');
    invocations.push({ queue: options.queue, at: clock, deadlineAt: options.deadlineAt });
    if (idle.includes(options.queue)) return { calls: 0 };
    clock += elapsedPerCall;
    return { calls: 1 };
  };
  return { pool, runner, now, start, invocations, queries, elapsed: () => clock - start,
    run: () => runNotificationQueues(pool, { runner, now }) };
}

test('slow quote backlog still serves guest enquiries before the shared deadline expires', async () => {
  // The former quote-first scheduler used all 45 seconds on 15 quote calls
  // with two-second responses plus one-second pauses, serving zero guests.
  const h = harness({ elapsedPerCall: 3000 });
  assert.deepEqual(await h.run(), { quote: { calls: 11 }, guest: { calls: 4 } });
  assert.deepEqual(h.invocations.slice(0, 8).map(turn => turn.queue),
    ['quote', 'guest', 'quote', 'guest', 'quote', 'guest', 'quote', 'guest']);
  assert.equal(h.invocations[1].at - h.start, 3000);
  assert.equal(h.elapsed(), 45_000);
  assert.equal(h.invocations.length, 15);
});

test('a full fast backlog stays within 16 quote calls, four guest calls and 20 total', async () => {
  const h = harness({ elapsedPerCall: 1000 });
  assert.deepEqual(await h.run(), { quote: { calls: 16 }, guest: { calls: 4 } });
  assert.equal(h.invocations.length, 20);
  assert.equal(h.invocations.filter(turn => turn.queue === 'quote').length, 16);
  assert.equal(h.invocations.filter(turn => turn.queue === 'guest').length, 4);
  assert.equal(h.queries.length, 1, 'Queue availability is a single read-only lookup.');
});

test('the shared deadline is never renewed between queue turns', async () => {
  const h = harness({ elapsedPerCall: 16_000 });
  assert.deepEqual(await h.run(), { quote: { calls: 2 }, guest: { calls: 1 } });
  assert.deepEqual(h.invocations.map(turn => turn.at - h.start), [0, 16_000, 32_000]);
  // An already-started request can finish after the deadline; no later turn starts.
  assert.equal(h.elapsed(), 48_000);
});

test('time spent checking queue availability also consumes the shared deadline', async () => {
  const h = harness({ lookupElapsed: 45_000 });
  assert.deepEqual(await h.run(), { quote: { calls: 0 }, guest: { calls: 0 } });
  assert.equal(h.invocations.length, 0);
  assert.equal(h.queries.length, 1);
});

test('an absent guest table skips all guest turns while retaining the quote budget', async () => {
  const h = harness({ guestReady: false });
  assert.deepEqual(await h.run(), { quote: { calls: 16 }, guest: { calls: 0 } });
  assert.equal(h.invocations.length, 16);
  assert.ok(h.invocations.every(turn => turn.queue === 'quote'));
  assert.equal(h.queries.length, 1);
});

test('an idle queue is tried once and does not prevent the other queue from running', async () => {
  for (const idle of ['quote', 'guest']) {
    const h = harness({ idle: [idle] });
    const result = await h.run();
    assert.equal(result[idle].calls, 0);
    assert.equal(h.invocations.filter(turn => turn.queue === idle).length, 1);
    const active = idle === 'quote' ? 'guest' : 'quote';
    assert.equal(result[active].calls, active === 'quote' ? 16 : 4);
  }
});

test('two idle queues each get only one local worker check and no mail calls', async () => {
  const h = harness({ idle: ['quote', 'guest'] });
  assert.deepEqual(await h.run(), { quote: { calls: 0 }, guest: { calls: 0 } });
  assert.deepEqual(h.invocations.map(turn => turn.queue), ['quote', 'guest']);
  assert.equal(h.queries.length, 1);
});
