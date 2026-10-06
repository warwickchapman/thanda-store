import test from 'node:test';
import assert from 'node:assert/strict';
import { itemCreationPreview, retirementReason } from '../src/lib/xero-item-create.mjs';
const product = { supplier: 'victron', sku: 'BPP900453100', name: 'Nucleo GX', details: { xeroStockStatus: 'missing', currency: 'ZAR', catalogueCurrency: 'ZAR', cataloguePresent: true, catalogueObservedAt: new Date().toISOString(), cataloguePrice: '2114.70', catalogueListPrice: 4028 } };
test('approved pricing and no stock fields in payload', () => {
  const p = itemCreationPreview(product, []);
  assert.equal(p.eligible, true); assert.equal(p.selling, 4028);
  assert.deepEqual(Object.keys(p.payload).sort(), ['action','code','cost','expectedCost','expectedItemId','list','name','observedAt']);
  assert.equal(itemCreationPreview({...product,details:{...product.details,cataloguePrice:'5245.28'}},[]).selling,4028);
});
test('missing/stale evidence and saved decisions fail closed', () => {
  for (const delta of [{catalogueListPrice:0},{cataloguePresent:false},{cataloguePrice:null},{catalogueObservedAt:null},{catalogueObservedAt:'2020-01-01'},{catalogueCurrency:'EUR'},{purchasingRetiredReason:'discontinued'}]) assert.equal(itemCreationPreview({...product,details:{...product.details,...delta}},[]).eligible,false);
  assert.equal(itemCreationPreview({...product,stockReview:{decision:'do_not_stock'}},[]).eligible,false);
});
test('succession and end-of-life require confirmed zero or complete-scan absence', () => {
  const old = {name:'Old panel *If 0, order SPM040203603*'};
  assert.match(retirementReason(old,null,'SPM040203603'),/Superseded/);
  assert.equal(retirementReason(old,{stock_quantity:2},'SPM040203603'),null);
  assert.equal(retirementReason(old,{stock_quantity:null},'SPM040203603'),null);
  assert.match(retirementReason(old,{stock_quantity:0},'SPM040203603'),/Superseded/);
  const ending = {name:'Cable *Available until stock 0*'};
  assert.match(retirementReason(ending,{stock_quantity:0},null),/now zero/);
  assert.match(retirementReason(ending,null,null),/absent/);
  assert.equal(retirementReason({name:'ordinary'},null,null),null);
});
test('canonical predecessor cannot be offered without catalogue evidence', () => {
  const p=itemCreationPreview({...product,sku:'PMP482305010',details:{...product.details,cataloguePresent:false}},[{predecessor_sku:'PMP482305010',successor_sku:'PMP482305012'}]);
  assert.equal(p.eligible,false);assert.match(p.reason,/PMP482305012/);
});

test('new-item preview calculates missing list from normal cost', () => {
  const p=itemCreationPreview({...product,details:{...product.details,catalogueListPrice:null,cataloguePrice:5245.28}},[]);
  assert.equal(p.eligible,true); assert.equal(p.selling,9991.01); assert.equal(p.listSource,'calculated');
});
