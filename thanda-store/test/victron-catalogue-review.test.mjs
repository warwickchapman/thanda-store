import test from 'node:test';
import assert from 'node:assert/strict';
import { prices, exclusion, reviewCatalogue, advanceHistory, changeSignature, zaWarehouseStock, needsAttention } from '../src/lib/victron-catalogue-review.mjs';
import { readItems } from '../src/lib/victron-catalogue-service.mjs';
const now = Date.now(), observedAt = new Date(now).toISOString();
const p = { sku:'PMP482305012', description:'MultiPlus II', currency:'ZAR', price:525, enduser_price_zar:{price:1000}, price_break_price:400 };
const items = {'thanda-solar':[], 'sensible-solar':[]};
const run = options => reviewCatalogue({catalogue:[p], items, observedAt, now, ...options});
test('company cost policies use supplier prices, not quantity breaks; explicit list takes precedence', () => {
  assert.deepEqual(prices(p), {cost:525,list:1000,sensible:600,listSource:'eorder'});
  assert.equal(prices({...p,price:450}).sensible,600);
  assert.equal(prices({...p,enduser_price_zar:null}).sensible,600);
  assert.ok(prices({...p,currency:null}).error);
  assert.deepEqual(run().map(r=>r.proposed).sort((a,b)=>a-b),[525,600]);
});
test('panel prefixes exclude panels without excluding category accessories or SolarSense', () => {
  for (const sku of ['SPM123','SPP123','spm123']) assert.ok(exclusion({...p,sku}));
  for (const [sku,description] of [['SCA520500000','Solar panel MC4-Y connector'],['SLS300175100','SolarSense 750']]) {
    const product = {...p,sku,description,category:'Solar panels and cables',subcategory:'Cables, connectors and accessories for solar panels'};
    assert.equal(exclusion(product),null);
    assert.ok(run({catalogue:[product]}).every(row => row.kind === 'new'));
  }
  assert.equal(exclusion({...p,description:'SmartSolar MPPT charge controller'}),null);
});

test('ZA warehouse evidence preserves unknown and never borrows generic or overseas stock', () => {
  for (const value of [undefined,null,'','   ',true,[],{},-1,Infinity,'-1','1e3','0x10','invalid']) {
    assert.equal(zaWarehouseStock({stock_quantity:99,all_stock_by_warehouse:{af_sa_inzuzo:value,eu_nl_arvato:123}}),null);
  }
  for (const value of [0,3,'0','35',' 4 ']) {
    assert.equal(zaWarehouseStock({all_stock_by_warehouse:{af_sa_inzuzo:value}}),Number(value));
  }
});

test('ZA-stocked review candidates sort first; zero and unknown remain visible, uncounted', () => {
  const catalogue = [
    {...p,sku:'PIN1',description:'120V inverter',all_stock_by_warehouse:{af_sa_inzuzo:0}},
    {...p,sku:'PIN2',description:'120V inverter',stock_quantity:99},
    {...p,sku:'PIN3',description:'120V inverter',all_stock_by_warehouse:{af_sa_inzuzo:3}},
    {...p,sku:'PIN4',description:'120V inverter',all_stock_by_warehouse:{af_sa_inzuzo:20}},
  ];
  const rows = run({catalogue});
  for (const company of Object.keys(items)) {
    const selected = rows.filter(row => row.company === company);
    assert.deepEqual(selected.map(row => row.sku),['PIN3','PIN4','PIN1','PIN2']);
    assert.ok(selected.every(row => row.kind === 'review'));
    assert.deepEqual(selected.map(row => row.zaStock),[3,20,0,null]);
    assert.equal(selected.filter(needsAttention).length,2);
  }
  const promoted = run({catalogue:catalogue.map(row => row.sku === 'PIN1' ? {...row,all_stock_by_warehouse:{af_sa_inzuzo:1}} : row)});
  assert.equal(promoted.filter(row => row.company === 'thanda-solar')[0].sku,'PIN1');
  assert.equal(promoted.filter(row => row.company === 'thanda-solar').filter(needsAttention).length,3);
});

test('review priority does not borrow successor, retail sibling or Xero stock', () => {
  const catalogue = [
    {...p,sku:'PMP482305010',description:'120V inverter'},
    {...p,description:'120V inverter',all_stock_by_warehouse:{af_sa_inzuzo:2}},
    {...p,sku:p.sku+'R',description:'120V inverter retail'},
  ];
  const existing = {...items,'thanda-solar':[{Code:'PMP482305010',ItemID:'old',QuantityOnHand:20,PurchaseDetails:{UnitPrice:525}}]};
  const rows=run({catalogue,items:existing,successions:[{predecessor_sku:'PMP482305010',successor_sku:p.sku}]});
  const old = rows.find(row => row.company === 'thanda-solar' && row.sku === 'PMP482305010');
  assert.equal(old.stock,20); assert.equal(old.zaStock,null); assert.equal(needsAttention(old),false);
  assert.deepEqual(old.replacedBy,[p.sku]);
  assert.equal(rows.find(row => row.sku === p.sku+'R').zaStock,null);
  assert.ok(rows.filter(needsAttention).every(row => row.sku === p.sku));
});

test('silenced review rows do not alert; return to ZA stock alerts without quantity churn', () => {
  const candidate={...p,description:'120V inverter',all_stock_by_warehouse:{af_sa_inzuzo:0}};
  const quiet=run({catalogue:[candidate]});
  assert.equal(changeSignature(quiet),changeSignature([]));
  assert.equal(changeSignature(run({catalogue:[{...candidate,price:526}]})),changeSignature(quiet));
  const stocked=run({catalogue:[{...candidate,all_stock_by_warehouse:{af_sa_inzuzo:1}}]});
  const more=run({catalogue:[{...candidate,all_stock_by_warehouse:{af_sa_inzuzo:5}}]});
  assert.notEqual(changeSignature(quiet),changeSignature(stocked));
  assert.equal(changeSignature(stocked),changeSignature(more));
  assert.equal(changeSignature(quiet),changeSignature(run({catalogue:[candidate]})));
});

test('ZA quantity changes do not invalidate existing price or creation approvals', () => {
  for (const existing of [items,{...items,'thanda-solar':[{Code:p.sku,ItemID:'x',PurchaseDetails:{UnitPrice:400}}]}]) {
    const before=run({items:existing,catalogue:[{...p,all_stock_by_warehouse:{af_sa_inzuzo:0}}]});
    const after=run({items:existing,catalogue:[{...p,all_stock_by_warehouse:{af_sa_inzuzo:10}}]});
    assert.deepEqual(before.map(row => row.fingerprint),after.map(row => row.fingerprint));
    assert.equal(changeSignature(before),changeSignature(after));
  }
});

const advisoryProduct = {...p,description:'120V inverter',all_stock_by_warehouse:{af_sa_inzuzo:3}};
const xeroAdvisory = cost => ({...items,'thanda-solar':[{Code:p.sku,ItemID:'item',IsPurchased:true,PurchaseDetails:{UnitPrice:cost}}]});
test('review actions distinguish missing items, cost changes and existing current costs', () => {
  assert.equal(run({catalogue:[advisoryProduct]})[0].reviewAction,'new');
  const changed=run({catalogue:[advisoryProduct],items:xeroAdvisory(400)}).find(row=>row.company==='thanda-solar');
  const current=run({catalogue:[advisoryProduct],items:xeroAdvisory(525)}).find(row=>row.company==='thanda-solar');
  assert.equal(changed.reviewAction,'price'); assert.equal(current.reviewAction,'keep');
  assert.match(changed.approvalReason,/120V/); assert.equal(changed.reviewBlocker,null);
});

test('accepting voltage advice cannot waive pricing, panel, alias, phase-out or purchasing gates', () => {
  const approval={company:'thanda-solar',sku:p.sku,approvedReason:exclusion(advisoryProduct)};
  for (const price of [0,-1,null,'invalid']) {
    const row=run({catalogue:[{...advisoryProduct,price}],decisions:[approval]}).find(row=>row.company==='thanda-solar');
    assert.equal(row.kind,'review'); assert.equal(row.reviewAction,null); assert.ok(row.reviewBlocker);
  }
  const disabled={...xeroAdvisory(400),'thanda-solar':[{...xeroAdvisory(400)['thanda-solar'][0],IsPurchased:false}]};
  assert.equal(run({catalogue:[advisoryProduct],items:disabled,decisions:[approval]}).find(row=>row.company==='thanda-solar').reviewAction,null);
  for (const changes of [{IsPurchased:null},{IsPurchased:undefined},{ItemID:null}]) {
    const uncertain={...xeroAdvisory(525),'thanda-solar':[{...xeroAdvisory(525)['thanda-solar'][0],...changes}]};
    const row=run({catalogue:[advisoryProduct],items:uncertain}).find(row=>row.company==='thanda-solar');
    assert.equal(row.reviewAction,null); assert.ok(row.reviewBlocker);
  }
  const aliases={...items,'thanda-solar':[{Code:p.sku+'R'}]};
  assert.equal(run({catalogue:[advisoryProduct],items:aliases,decisions:[approval]}).find(row=>row.company==='thanda-solar').reviewAction,null);
  const old={...advisoryProduct,description:'120V inverter Available until stock 0'};
  assert.equal(run({catalogue:[old],decisions:[approval]}).find(row=>row.company==='thanda-solar').reviewAction,null);
  const panel={...advisoryProduct,sku:'SPM123'};
  assert.equal(run({catalogue:[panel],decisions:[{...approval,sku:panel.sku,approvedReason:exclusion(panel)}]}).find(row=>row.company==='thanda-solar').reviewAction,null);
});

test('approval accepts only the same advisory, company and literal SKU, never successors or retail siblings', () => {
  const approval={company:'thanda-solar',sku:p.sku,approvedReason:exclusion(advisoryProduct)};
  const rows=run({catalogue:[advisoryProduct],decisions:[approval]});
  assert.equal(rows.find(row=>row.company==='thanda-solar').kind,'new');
  assert.equal(rows.find(row=>row.company==='sensible-solar').kind,'review');
  assert.equal(run({catalogue:[advisoryProduct],items:xeroAdvisory(525),decisions:[approval]}).filter(row=>row.company==='thanda-solar').length,0);
  for (const sku of ['PMP482305010',p.sku+'R']) {
    const row=run({catalogue:[{...advisoryProduct,sku}],decisions:[approval],successions:[{predecessor_sku:'PMP482305010',successor_sku:p.sku}]}).find(row=>row.company==='thanda-solar');
    assert.equal(row.kind,'review');
  }
  const changed=run({catalogue:[{...advisoryProduct,description:'Solar home system'}],decisions:[approval]}).find(row=>row.company==='thanda-solar');
  assert.equal(changed.kind,'review'); assert.match(changed.approvalReason,/home system/i);
  const additional=run({catalogue:[{...advisoryProduct,category:'Solar home system'}],items:xeroAdvisory(525),decisions:[approval]}).find(row=>row.company==='thanda-solar');
  assert.equal(additional.kind,'review'); assert.match(additional.approvalReason,/120V.*home system/i);
});

test('ignore is company/SKU scoped, expires at its deadline and suppresses stock arrivals while active', () => {
  const ignoredUntil=new Date(now+90*86400000).toISOString();
  const decision={company:'thanda-solar',sku:p.sku,ignoredUntil};
  const before=run({catalogue:[advisoryProduct]});
  const rows=run({catalogue:[advisoryProduct],decisions:[decision]});
  const ignored=rows.find(row=>row.company==='thanda-solar');
  assert.equal(ignored.ignoredUntil,ignoredUntil); assert.equal(needsAttention(ignored),false);
  assert.equal(rows.find(row=>row.company==='sensible-solar').ignoredUntil,null);
  assert.equal(before.find(row=>row.company==='thanda-solar').fingerprint,ignored.fingerprint);
  const zero=run({catalogue:[{...advisoryProduct,all_stock_by_warehouse:{af_sa_inzuzo:0}}],decisions:[decision]});
  assert.equal(needsAttention(zero.find(row=>row.company==='thanda-solar')),false);
  for (const expiry of [new Date(now).toISOString(),new Date(now-1).toISOString()]) {
    const expired=run({catalogue:[advisoryProduct],decisions:[{...decision,ignoredUntil:expiry}]}).find(row=>row.company==='thanda-solar');
    assert.equal(expired.ignoredUntil,null); assert.equal(needsAttention(expired),true);
    assert.notEqual(changeSignature([ignored]),changeSignature([expired]));
  }
  const alias=run({catalogue:[{...advisoryProduct,sku:p.sku+'R'}],decisions:[decision]}).find(row=>row.company==='thanda-solar');
  assert.equal(needsAttention(alias),true);
});

test('ignore cannot hide ordinary price or archive changes', () => {
  const decision={company:'thanda-solar',sku:p.sku,ignoredUntil:new Date(now+90*86400000).toISOString()};
  const price=run({items:xeroAdvisory(400),decisions:[decision]}).find(row=>row.company==='thanda-solar');
  assert.equal(price.kind,'price'); assert.equal(needsAttention(price),true);
  const archive=run({items:xeroAdvisory(400),catalogue:[{...p,description:'Available until stock 0',stock_quantity:0}],decisions:[decision]}).find(row=>row.company==='thanda-solar');
  assert.equal(archive.kind,'archive'); assert.equal(needsAttention(archive),true);
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

test('missing list uses normal cost / 0.525 for both companies and new products', () => {
  for (const value of [undefined,null,'','   ']) {
    const product={...p,price:5245.28,enduser_price_zar:{price:value}};
    assert.deepEqual(prices(product),{cost:5245.28,list:9991.01,sensible:5994.61,listSource:'calculated'});
    assert.ok(run({catalogue:[product]}).every(r=>r.kind==='new' && r.listSource==='calculated'));
  }
  for (const value of [0,-1,'invalid',Infinity]) assert.ok(prices({...p,enduser_price_zar:{price:value}}).error);
});

test('cost approvals and alerts survive unchanged observations, stock and description changes', () => {
  const existing = Object.fromEntries(Object.keys(items).map(company => [company, [{
    Code: p.sku, ItemID: `${company}-item`, IsPurchased: true,
    PurchaseDetails: { UnitPrice: 400 }, QuantityOnHand: 1,
  }]]));
  const before = run({ items: existing });
  const refreshed = run({
    items: Object.fromEntries(Object.entries(existing).map(([company, entries]) => [company,
      entries.map(item => ({ ...item, QuantityOnHand: 2 }))])),
    observedAt: new Date(now + 1000).toISOString(),
    catalogue: [{ ...p, description: 'Updated supplier description' }],
    successions: [{ predecessor_sku: 'PMP482305010', successor_sku: p.sku }],
  });
  assert.deepEqual(before.map(r => r.fingerprint), refreshed.map(r => r.fingerprint));
  assert.equal(changeSignature(before), changeSignature(refreshed));
  assert.ok(refreshed.every(r => r.replaces.includes('PMP482305010')));
  assert.ok(refreshed.every(r => r.stock === 2));
  for (const changes of [
    { PurchaseDetails: { UnitPrice: 401 } }, { ItemID: 'different-item' }, { IsPurchased: false },
  ]) {
    const changed = run({ items: { ...existing, 'thanda-solar': [{ ...existing['thanda-solar'][0], ...changes }] } });
    assert.notEqual(before.find(r => r.company === 'thanda-solar').fingerprint,
      changed.find(r => r.company === 'thanda-solar').fingerprint);
  }
  const changedCost = run({ items: existing, catalogue: [{ ...p, price: 526 }] });
  assert.notEqual(before.find(r => r.company === 'thanda-solar').fingerprint,
    changedCost.find(r => r.company === 'thanda-solar').fingerprint);
  const changedList = run({ items: existing, catalogue: [{ ...p, enduser_price_zar: { price: 1010 } }] });
  assert.notEqual(before.find(r => r.company === 'sensible-solar').fingerprint,
    changedList.find(r => r.company === 'sensible-solar').fingerprint);
});

test('archive approvals still depend on stock and new-item approvals on selling price', () => {
  const existing = { ...items, 'thanda-solar': [{ Code: p.sku, ItemID: 'item', IsPurchased: true,
    PurchaseDetails: { UnitPrice: 400 }, QuantityOnHand: 0 }] };
  const options = { items: existing, catalogue: [{ ...p, description: 'Available until stock 0', stock_quantity: 0 }] };
  const before = run(options).find(r => r.company === 'thanda-solar');
  assert.equal(before.kind, 'archive');
  const after = run({ ...options, items: { ...existing, 'thanda-solar': [{ ...existing['thanda-solar'][0], QuantityOnHand: 1 }] } }).find(r => r.company === 'thanda-solar');
  assert.notEqual(before.fingerprint, after.fingerprint);
  assert.notEqual(run()[0].fingerprint, run({ catalogue: [{ ...p, enduser_price_zar: { price: 1010 } }] })[0].fingerprint);
});
