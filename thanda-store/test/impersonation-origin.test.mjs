import assert from 'node:assert/strict';
import test from 'node:test';
import { validCustomerViewOrigin } from '../src/lib/auth/impersonation-origin.mjs';

function request(origin) {
  return new Request('http://127.0.0.1:3000/api/admin/impersonation', {
    method: 'POST',
    headers: origin ? { origin } : {},
  });
}

test('accepts the public Store origin behind a local production proxy', () => {
  assert.equal(validCustomerViewOrigin(request('https://store.thanda.solar'), { nodeEnv: 'production' }), true);
});

test('uses an explicitly configured public origin', () => {
  assert.equal(validCustomerViewOrigin(request('https://store.thanda.solar'), { portalBaseUrl: 'https://store.thanda.solar/', nodeEnv: 'production' }), true);
});

test('rejects foreign, missing, and malformed origins', () => {
  for (const origin of ['https://another.example', 'https://store.thanda.solar.evil.example', 'http://store.thanda.solar', null, 'invalid']) {
    assert.equal(validCustomerViewOrigin(request(origin), { nodeEnv: 'production' }), false, String(origin));
  }
});

test('local development may use its local request origin', () => {
  assert.equal(validCustomerViewOrigin(request('http://127.0.0.1:3000'), { nodeEnv: 'development' }), true);
});
