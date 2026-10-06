import test from 'node:test';
import assert from 'node:assert/strict';
import { prices, exclusion, reviewCatalogue, advanceHistory, changeSignature } from '../src/lib/victron-catalogue-review.mjs';
import { readItems } from '../src/lib/victron-catalogue-service.mjs';
const now = Date.now(), observedAt = new Date(now).toISOString();
const p = { sku:'PMP482305012', description:'MultiPlus II', currency:'ZAR', price:525, enduser_price_zar:{price:1000}, price_break_price:400 };
const items = {'thanda-solar':[], 'sensible-solar':[]};
const run = options => reviewCatalogue({catalogue:[p], items, observedAt, now, ...options});
test('company cost policies use supplier prices, not quantity breaks or reconstructed list', () => {
  assert.deepEqual(prices(p), {cost:525,list:1000,sensible:600});
  assert.equal(prices({...p,price:450}).sensible,600);
  assert.equal(prices({...p,enduser_price_zar:null}).sensible,null);
  assert.ok(prices({...p,currency:null}).error);
  assert.deepEqual(run().map(r=>r.proposed).sort((a,b)=>a-b),[525,600]);
});
test('panels excluded without excluding chargers', () => {
  assert.ok(exclusion({...p,sku:'SPM123'})); assert.ok(exclusion({...p,description:'Solar panel 300W'}));
  assert.equal(exclusion({...p,description:'SmartSolar MPPT charge controller'}),null);
});
test('successors are separate definitions; retail alias is manual review', () => {
  const successions=[{predecessor_sku:'PMP482305010',successor_sku:p.sku}];
  const existing={...items,'thanda-solar':[{Code:'PMP482305010',ItemID:'old',Name:'Victron predecessor',PurchaseDetails:{UnitPrice:123},QuantityOnHand:2}]};
  const rows=run({items:existing,successions});
  assert.equal(rows.find(r=>r.company==='thanda-solar' && r.sku===p.sku).kind,'new');
  assert.deepEqual(rows.find(r=>r.sku===p.sku).replaces,['PMP482305010']);
  assert.ok(rows.find(r=>r.sku==='PMP482305010').replacedBy.includes(p.sku));
  const aliases=run({items:{...items,'thanda-solar':[{Code:p.sku+'R'}]}});
  assert.match(aliases.find(r=>r.company==='thanda-solar').reason,/alias/);
});
test('failed/stale evidence does not establish changes or absences', () => {
  assert.throws(()=>run({catalogue:[]}),/complete/);
  assert.throws(()=>run({observedAt:'2020-01-01'}),/24 hours/);
  assert.throws(()=>run({items:{}}),/Complete Xero/);
});
test('absence counts distinct observation days and clears on return', () => {
  const first=advanceHistory({OLD:{day:null,absentDays:0}},[p],'2026-10-05');
  const same=advanceHistory(first,[p],'2026-10-05'); assert.equal(same.OLD.absentDays,1);
  const next=advanceHistory(same,[p],'2026-10-06'); assert.equal(next.OLD.absentDays,2);
  assert.equal(advanceHistory(next,[p,{sku:'OLD'}],'2026-10-06').OLD.absentDays,0);
});
test('unchanged proposals do not repeat alerts when observations refresh', () => {
  assert.equal(changeSignature(run()),changeSignature(run({observedAt:new Date(now+1000).toISOString()})));
  assert.notEqual(changeSignature(run()),changeSignature(run({catalogue:[{...p,price:526}]})));
});
test('cost parity skips proposals but missing Xero cost is not zero', () => {
  const existing={...items,'thanda-solar':[{Code:p.sku,ItemID:'x',IsPurchased:true,PurchaseDetails:{UnitPrice:525}}]};
  assert.equal(run({items:existing}).filter(r=>r.company==='thanda-solar').length,0);
});
test('Hub reads reject cross-tenant and incomplete evidence', async () => {
  const request=async()=>Response.json({Items:[],_hub:{complete:true,snapshot:'1',observed_at:observedAt,company:'sensible-solar'}});
  await assert.rejects(()=>readItems('thanda-solar',request),/stale or incomplete/);
  await assert.rejects(()=>readItems('thanda-solar',async()=>Response.json({Items:[]})),/incomplete/);
});
test('explicit successor with confirmed supplier zero stock qualifies for retirement, unknown stock does not', () => {
  const successions=[{predecessor_sku:p.sku,successor_sku:'PMP482305014'}];
  const existing={...items,'thanda-solar':[{Code:p.sku,ItemID:'x',IsPurchased:true,PurchaseDetails:{UnitPrice:525},QuantityOnHand:0}]};
  const row=run({items:existing,successions,catalogue:[{...p,stock_quantity:0}]}).find(r=>r.company==='thanda-solar');
  assert.equal(row.kind,'archive'); assert.equal(row.eligibleForArchiveReview,true);
  assert.equal(run({items:existing,successions}).filter(r=>r.company==='thanda-solar').length,0);
});
