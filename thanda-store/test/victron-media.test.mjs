import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ensureVictronMediaSchema, loadVictronMediaState, recordVictronMediaAttempt,
  selectVictronMediaCandidates, victronMediaFromExtended,
} from '../src/lib/victron-media.mjs';

const now = Date.parse('2026-10-23T08:00:00Z');
const product = (sku, extra = {}) => ({ sku, supplier: 'victron', image_url: '', details: {}, ...extra });

test('bounded missing-photo queue favours held stock, then supplier stock; literal SKU media stays separate', () => {
  const products = [product('PMP482305010'), product('ORI121221040', { details: { localStockOnHand: 2 } }),
    product('PMP482305012', { stock_on_hand: 10 }), product('OTHER'), product('ORI121221040')];
  assert.deepEqual(selectVictronMediaCandidates(products, new Map(), { limit: 3, now }).map(row => row.sku),
    ['ORI121221040', 'PMP482305012', 'OTHER']);
  assert.deepEqual(selectVictronMediaCandidates(products, new Map(), { limit: 0, now }), []);
  assert.throws(() => selectVictronMediaCandidates(products, new Map(), { limit: 101, now }), /batch size/);
});

test('valid images, uploaded or editorial media, hidden and Store-managed products do not spend requests', () => {
  const rows = [product('PHOTO', { image_url: 'https://www.victronenergy.com/photo.png' }),
    product('LOCAL', { image_url: '/images/photo.jpg' }),
    product('UPLOADED', { image_url: '/api/store-product-images/123?v=abc' }),
    product('EDITORIAL', { details: { imageSource: 'manual' } }),
    product('MANAGED', { details: { storeManaged: true } }),
    product('HIDDEN', { details: { hidden: true } }),
    product('RENOGY', { supplier: 'renogy' }), product('MISSING')];
  assert.deepEqual(selectVictronMediaCandidates(rows, new Map(), { now }).map(row => row.sku), ['MISSING']);
});

test('persisted retry times keep unavailable photos quiet until due without blocking other articles', () => {
  const states = new Map([['LATER', { next_attempt_at: new Date(now + 1) }],
    ['DUE', { next_attempt_at: new Date(now) }]]);
  assert.deepEqual(selectVictronMediaCandidates([product('LATER'), product('DUE'), product('NEW')], states, { now })
    .map(row => row.sku), ['DUE', 'NEW']);
});

test('newest products advance first within a stock priority and a requested SKU obeys the same caps and cooldowns', () => {
  const rows = [product('OLD', { id: 1 }), product('NEW', { id: 10 }),
    product('HELD', { id: 2, details: { localStockOnHand: 1 } })];
  assert.deepEqual(selectVictronMediaCandidates(rows, new Map(), { limit: 2, now }).map(row => row.sku), ['HELD', 'NEW']);
  assert.deepEqual(selectVictronMediaCandidates(rows, new Map(), { limit: 1, now, preferredSku: 'old' }).map(row => row.sku), ['OLD']);
  assert.deepEqual(selectVictronMediaCandidates(rows, new Map([['OLD', { next_attempt_at: now + 1 }]]),
    { limit: 1, now, preferredSku: 'old' }).map(row => row.sku), ['HELD']);
});

test('intentional refresh can include existing supplier images but cannot replace protected editorial media', () => {
  const rows = [product('PHOTO', { image_url: 'https://www.victronenergy.com/photo.png' }),
    product('UPLOADED', { image_url: '/api/store-product-images/123' }),
    product('MANAGED', { details: { storeManaged: true } })];
  assert.deepEqual(selectVictronMediaCandidates(rows, new Map(), { now }), []);
  assert.deepEqual(selectVictronMediaCandidates(rows, new Map(), { now, refreshExisting: true }).map(row => row.sku), ['PHOTO']);
});

test('sparse and malformed media fields cannot erase existing details', () => {
  const retained = { image_url: 'https://example.com/old.jpg', details: { description: 'Saved', documents: [{ url: 'https://example.com/doc.pdf' }], technicalData: [{ name: 'Power', value: '70A' }] } };
  const patch = victronMediaFromExtended({ sku: 'ORI121221040', product_data: { main_images: [], description: ' ', documents: {}, pms_technical_data: [] } }, 'ORI121221040');
  assert.deepEqual(patch, { details: {} });
  assert.deepEqual({ ...retained, ...patch, details: { ...retained.details, ...patch.details } }, retained);
  for (const payload of [null, [], { product_data: [] }, { sku: 'OTHER', product_data: {} }, { raw: 'Internal Server Error' }])
    assert.throws(() => victronMediaFromExtended(payload, 'ORI121221040'), /Invalid Victron extended/);
});

test('valid extended photo and useful details are retained while invalid URLs are omitted', () => {
  const patch = victronMediaFromExtended({ sku: 'ORI121221040', product_data: {
    main_images: [{ url: 'javascript:alert(1)' }, { url: 'https://www.victronenergy.com/photo.png' }],
    description: ' Useful description ', documents: [{ url: 'javascript:alert(1)' }, { url: 'https://www.victronenergy.com/manual.pdf', kind: 'manual' }],
    pms_technical_data: [{ name: 'Current', value: '70A' }, null],
  } }, 'ori121221040');
  assert.equal(patch.image_url, 'https://www.victronenergy.com/photo.png');
  assert.equal(patch.details.imageSource, 'victron-products-extended');
  assert.equal(patch.details.documents.length, 1);
  assert.equal(patch.details.technicalData.length, 1);
  assert.equal(patch.details.description, ' Useful description ');
});

test('automatic media accepts only HTTPS Victron origins and preserves legitimate existing images independently', () => {
  for (const address of ['http://www.victronenergy.com/photo.png', 'https://localhost/photo.png',
    'https://127.0.0.1/photo.png', 'https://victronenergy.com.evil.example/photo.png',
    'https://evilvictronenergy.com/photo.png', 'https://user:pass@www.victronenergy.com/photo.png',
    'https://www.victronenergy.com:8443/photo.png']) {
    assert.deepEqual(victronMediaFromExtended({ product_data: { main_images: [{ url: address }], documents: [{ url: address }] } }, 'SKU'), { details: {} });
  }
  assert.equal(victronMediaFromExtended({ product_data: { image: 'https://cdn.victronenergy.com/photo.png' } }, 'SKU').image_url,
    'https://cdn.victronenergy.com/photo.png');
  assert.deepEqual(selectVictronMediaCandidates([product('EXISTING', { image_url: 'https://legitimate-store-cdn.example/photo.png' })], new Map(), { now }), []);
});

test('media state is local, SKU-scoped and monotonic with bounded persisted retry backoff', async () => {
  const calls = [];
  const db = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [{ sku: 'ORI121221040', next_attempt_at: null }] }; } };
  await ensureVictronMediaSchema(db);
  const state = await loadVictronMediaState(db, ['ori121221040', 'ORI121221040', '']);
  assert.equal(state.has('ORI121221040'), true);
  assert.deepEqual(calls[1].values, [['ORI121221040']]);
  assert.equal(await recordVictronMediaAttempt(db, 'ori121221040', { outcome: 'missing', now }).then(row => row.sku), 'ORI121221040');
  const missing = calls.at(-1);
  assert.equal(missing.values[4], 7 * 86400_000);
  assert.equal(missing.values[5], 28 * 86400_000);
  assert.match(missing.sql, /attempted_at <= EXCLUDED.attempted_at/);
  assert.match(missing.sql, /LEAST\(.*unsuccessful_attempts.*4\)/);
  await recordVictronMediaAttempt(db, 'ORI121221040', { outcome: 'failed', now });
  assert.equal(calls.at(-1).values[4], 86400_000);
  assert.equal(calls.at(-1).values[5], 7 * 86400_000);
  const retryAt = new Date(now + 2 * 3600_000).toISOString();
  await recordVictronMediaAttempt(db, 'ORI121221040', { outcome: 'rate-limited', retryAt, now });
  assert.equal(calls.at(-1).values[3], retryAt);
  // A zero-second provider deadline can have passed by the time persistence
  // completes. Retain its exact deadline; the caller still stops this batch.
  await recordVictronMediaAttempt(db, 'ORI121221040', { outcome: 'rate-limited', retryAt: new Date(now - 1).toISOString(), now });
  assert.equal(calls.at(-1).values[3], new Date(now - 1).toISOString());
  const before = calls.length;
  await assert.rejects(recordVictronMediaAttempt(db, 'ORI121221040', { outcome: 'rate-limited', now }), /Invalid Victron media attempt/);
  await assert.rejects(recordVictronMediaAttempt(db, '', { outcome: 'failed', now }), /Invalid Victron media attempt/);
  assert.equal(calls.length, before);
});
