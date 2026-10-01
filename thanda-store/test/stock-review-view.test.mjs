import test from 'node:test';
import assert from 'node:assert/strict';
import { stockReviewView } from '../src/lib/stock-review-view.mjs';
import { skuReplacementContext } from '../src/lib/victron-sku-family.mjs';

test('review buckets are mutually exclusive, including restored and created items', () => {
  assert.equal(stockReviewView({xeroStatus:'missing', active:false}), 'needs');
  assert.equal(stockReviewView({xeroStatus:'missing', active:true}), 'reviewed');
  assert.equal(stockReviewView({xeroStatus:'missing', active:false, purchasingRestored:true}), 'needs');
  assert.equal(stockReviewView({xeroStatus:'missing', active:true, creationPending:true}), 'awaiting');
  assert.equal(stockReviewView({xeroStatus:'tracked', active:false}), 'reviewed');
});
test('replacement labels follow directed records, not alphabetical order', () => {
  const rows = [{predecessor_sku:'ASS030065050',successor_sku:'ASS030065051'}, {predecessor_sku:'PMP482305010',successor_sku:'PMP482305012'}];
  assert.deepEqual(skuReplacementContext(rows,'ASS030065051'), {replaces:['ASS030065050'],replacedBy:[]});
  assert.deepEqual(skuReplacementContext(rows,'ASS030065050'), {replaces:[],replacedBy:['ASS030065051']});
  assert.deepEqual(skuReplacementContext(rows,'PMP482305012R'), {replaces:['PMP482305010'],replacedBy:[]});
  assert.deepEqual(skuReplacementContext(rows,'OTHER'), {replaces:[],replacedBy:[]});
});
