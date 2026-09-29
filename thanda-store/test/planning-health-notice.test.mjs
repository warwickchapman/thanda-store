import test from 'node:test';
import assert from 'node:assert/strict';
import { planningHealthSignature as signature } from '../src/lib/planning-health-notice.mjs';

test('routine checks, ordering numbers and source message countdowns do not notify again', () => {
  const health = { sourceIssues: [{ id: 'victron', status: 'error', message: 'retry in 50 seconds' }], warnings: [] };
  assert.equal(signature(health, []), signature({ ...health, checkedAt: 'later', sourceIssues: [{ id: 'victron', status: 'error', message: 'retry in 20 seconds' }] }, [{ sku: 'A', suggestedOrder: 9, itemReviewReasons: [] }]));
});
test('new and resolved source incidents change the signature', () => {
  assert.notEqual(signature({ sourceIssues: [], warnings: [] }, []), signature({ sourceIssues: [{ id: 'victron', status: 'error' }], warnings: [] }, []));
});
test('item-specific missing data is tracked independently of generic confidence', () => {
  const health = { sourceIssues: [], warnings: [] };
  assert.equal(signature(health, []), signature(health, [{ sku: 'A', suggestedOrder: 1, confidence: 'provisional', itemReviewReasons: [] }]));
  assert.notEqual(signature(health, []), signature(health, [{ sku: 'A', suggestedOrder: null, itemReviewReasons: ['Stock unknown'] }]));
});
