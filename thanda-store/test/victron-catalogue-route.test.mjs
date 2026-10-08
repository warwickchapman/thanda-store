import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { submitCatalogueCommand } from '../src/lib/victron-catalogue-command.mjs';
import { validCustomerViewOrigin } from '../src/lib/auth/impersonation-origin.mjs';
import { stockSku } from '../src/lib/victron-sku-family.mjs';
import { needsAttention, catalogueCounts, recordReviewDecision } from '../src/lib/victron-catalogue-review.mjs';

// Exercise the actual Next route with real Web Request/Response objects. Only
// auth, stored evidence and I/O are replaced; command/audit handling is real.
const source = fs.readFileSync(new URL('../src/app/api/admin/victron-catalogue/route.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText;
const product = { fingerprint: 'comparison-fingerprint', company: 'thanda-solar', sku: 'ASS030720118', name: 'Victron cable',
  cost: 144.9, list: 276, proposed: 144.9, observedAt: new Date().toISOString(), kind: 'price', itemId: 'item-1', previous: 165.38 };
const single = { action: 'apply', fingerprint: product.fingerprint };
const batch = { action: 'apply-batch', fingerprints: [product.fingerprint] };

function harness(options = {}) {
  const rows = options.rows || [product];
  const audit = [], calls = [];
  let refreshes = 0, schemaCalls = 0;
  const pool = { query: async (sql, args) => {
    if (sql.startsWith('SELECT * FROM victron_catalogue_review')) return { rows: [{
      rows, checked_at: new Date().toISOString(), signature: 'current', acknowledged_signature: 'previous', ...options.state,
    }] };
    if (sql.startsWith('SELECT created_at,actor,action,company,sku,details')) return { rows: [] };
    if (sql.startsWith('INSERT INTO victron_catalogue_events')) {
      if (options.failAttempt) throw new Error('database internal failure');
      if (options.failDecision && String(args[1]).startsWith('review-')) throw new Error('database internal failure');
      audit.push({ action: args[1], company: args[2], sku: args[3], details: JSON.parse(args[4]) });
      return { rows: [{ id: 42 }] };
    }
    if (sql.startsWith('UPDATE victron_catalogue_events')) {
      if (options.failOutcome) throw new Error('database internal failure');
      assert.equal(args[0], 42);
      audit.push({ action: args[1], details: JSON.parse(args[2]) });
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const request = async (company, path, init) => {
    assert.equal(audit.length, 1, 'an attempt must exist before any Hub dispatch');
    const payload = JSON.parse(init.body);
    assert.deepEqual(payload, audit[0].details.request.payload, 'the exact dispatch is persisted');
    assert.equal(init.headers['X-Hub-Actor'], '7');
    calls.push({ company, path, payload });
    if (options.respond) return options.respond();
    return Response.json({ Items: rows.map(row => ({ Code: row.sku, ItemID: row.itemId || `new-item-${row.sku}`, PurchaseDetails: { UnitPrice: row.proposed }, SalesDetails: { UnitPrice: row.list } })) });
  };
  const modules = {
    'next/server': { NextResponse: Response },
    '@/lib/db': pool,
    '@/lib/auth/server': { currentUser: async () => options.user === undefined ? { id: 7, role: 'admin' } : options.user },
    '@/lib/auth/impersonation-origin.mjs': { validCustomerViewOrigin },
    '@/lib/victron-catalogue-service.mjs': { refreshReview: async () => {
      refreshes++;
      if (options.failRefresh && refreshes > 1) throw new Error('stored read failed');
      return { rows };
    } },
    '@/lib/victron-catalogue-command.mjs': { submitCatalogueCommand: (db, command) => submitCatalogueCommand(db, command, request) },
    '@/lib/victron-catalogue-review.mjs': { ensureReviewSchema: async () => { schemaCalls++; }, needsAttention, catalogueCounts, recordReviewDecision },
    '@/lib/victron-sku-family.mjs': { stockSku },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => {
    assert.ok(name in modules, `Unexpected import ${name}`);
    return modules[name];
  }, process: { env: { NODE_ENV: 'production' } }, Request, Response, Date, Set, JSON, Error, URL });
  return { audit, calls, schemaCalls: () => schemaCalls, get: async (summary = false) => {
    const response = await exports.GET(new Request(`https://store.thanda.solar/api/admin/victron-catalogue${summary ? '?summary=1' : ''}`));
    return { status: response.status, body: await response.json() };
  }, post: async (body = single) => {
    const response = await exports.POST(new Request('https://store.thanda.solar/api/admin/victron-catalogue', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: options.origin || 'https://store.thanda.solar' }, body: JSON.stringify(body),
    }));
    return { status: response.status, headers: response.headers, body: await response.json() };
  } };
}

test('review summary and full page silence zero/unknown stock without hiding rows or making Hub calls', async () => {
  const rows = [0,null,undefined].map((zaStock,index) => ({...product,sku:`PIN${index}`,kind:'review',zaStock}));
  const h=harness({rows});
  assert.equal((await h.get(true)).body.attention,false);
  const full=await h.get();
  assert.equal(full.status,200); assert.equal(full.body.attention,false); assert.equal(full.body.rows.length,3);
  assert.equal(h.calls.length,0);
  const stocked=harness({rows:[...rows,{...product,kind:'review',zaStock:1}]});
  assert.equal((await stocked.get(true)).body.attention,true);
  assert.equal((await stocked.get()).body.attention,true);
  const acknowledged=harness({rows:[{...product,kind:'review',zaStock:1}],state:{acknowledged_signature:'current'}});
  assert.equal((await acknowledged.get(true)).body.attention,true);
});

const reviewProduct = { ...product, kind:'review', reason:'120V-only model: South African eligibility requires review.',
  approvalReason:'120V-only model: South African eligibility requires review.',reviewBlocker:null,reviewAction:'price',zaStock:3,ignoredUntil:null };
test('review accepts server-derived new/price actions through the existing audited command and persists only confirmed approvals', async () => {
  for (const reviewAction of ['new','price']) {
    const row={...reviewProduct,reviewAction,itemId:reviewAction==='new'?null:product.itemId};
    const h=harness({rows:[row]});
    const result=await h.post({action:'resolve-review',fingerprint:row.fingerprint,reviewAction:'forged'});
    assert.equal(result.status,200); assert.equal(h.calls.length,1);
    assert.equal(h.calls[0].payload.action,reviewAction);
    assert.deepEqual(h.audit.map(event=>event.action),['pending','applied','review-approved']);
    assert.equal(h.audit.at(-1).company,row.company); assert.equal(h.audit.at(-1).sku,row.sku);
    assert.equal(h.audit.at(-1).details.approvedReason,row.approvalReason);
  }
  const rejected=harness({rows:[reviewProduct],respond:()=>Response.json({detail:'Rejected'},{status:409})});
  assert.equal((await rejected.post({action:'resolve-review',fingerprint:reviewProduct.fingerprint})).status,409);
  assert.ok(!rejected.audit.some(event=>event.action==='review-approved'));
  const unknown=harness({rows:[reviewProduct],respond:()=>new Response('Internal Server Error',{status:500})});
  assert.equal((await unknown.post({action:'resolve-review',fingerprint:reviewProduct.fingerprint})).body.code,'UNKNOWN_OUTCOME');
  assert.ok(!unknown.audit.some(event=>event.action==='review-approved'));
});

test('Keep in Xero records eligibility locally; decision failures prevent success without dispatch', async () => {
  const row={...reviewProduct,reviewAction:'keep',previous:reviewProduct.proposed};
  const h=harness({rows:[row]});
  const result=await h.post({action:'resolve-review',fingerprint:row.fingerprint});
  assert.equal(result.status,200); assert.equal(h.calls.length,0);
  assert.deepEqual(h.audit.map(event=>event.action),['review-approved']);
  const failed=harness({rows:[row],failDecision:true});
  assert.equal((await failed.post({action:'resolve-review',fingerprint:row.fingerprint})).status,503);
  assert.equal(failed.calls.length,0);
});

test('confirmed Xero result remains successful if the subsequent local review approval cannot be saved', async () => {
  const h=harness({rows:[reviewProduct],failDecision:true});
  const result=await h.post({action:'resolve-review',fingerprint:reviewProduct.fingerprint});
  assert.equal(result.status,200); assert.match(result.body.message,/Do not repeat/);
  assert.equal(h.calls.length,1); assert.deepEqual(h.audit.map(event=>event.action),['pending','applied']);
});

test('review resolution rejects ignored, unstocked, hard-blocked and ordinary rows before Hub dispatch', async () => {
  for (const row of [product,{...reviewProduct,ignoredUntil:'2099-01-01'},{...reviewProduct,zaStock:0},
    {...reviewProduct,zaStock:null},{...reviewProduct,reviewBlocker:'No valid price'},
    {...reviewProduct,reviewAction:null},{...reviewProduct,approvalReason:null}]) {
    const h=harness({rows:[row]});
    assert.equal((await h.post({action:'resolve-review',fingerprint:row.fingerprint})).status,409);
    assert.equal(h.calls.length,0); assert.equal(h.audit.length,0);
  }
});

test('ignore and undo are audited for the actual row company/SKU and make no Hub calls', async () => {
  for (const [action,saved] of [['ignore-review','review-ignored'],['unignore-review','review-resumed']]) {
    const h=harness({rows:[{...reviewProduct,company:'sensible-solar'}]});
    const result=await h.post({action,fingerprint:reviewProduct.fingerprint,company:'thanda-solar',sku:'forged',days:1000});
    assert.equal(result.status,200); assert.equal(h.calls.length,0);
    assert.equal(h.audit[0].action,saved); assert.equal(h.audit[0].company,'sensible-solar');
    assert.equal(h.audit[0].sku,reviewProduct.sku);
    assert.equal((await harness().post({action,fingerprint:product.fingerprint})).status,409);
  }
});

test('stale review selection and unauthorised/cross-origin decisions are rejected without local decisions or writes', async () => {
  assert.equal((await harness({rows:[reviewProduct]}).post({action:'resolve-review',fingerprint:'old'})).body.code,'STALE_SELECTION');
  for (const action of ['resolve-review','ignore-review','unignore-review']) {
    for (const options of [{user:null},{user:{id:7,role:'customer'}},{origin:'https://elsewhere.example'}]) {
      const h=harness({rows:[reviewProduct],...options});
      assert.equal((await h.post({action,fingerprint:reviewProduct.fingerprint})).status,403);
      assert.equal(h.audit.length,0); assert.equal(h.calls.length,0);
    }
  }
});

test('archive-only, failed or overdue comparisons do not light the menu dot; page warnings remain', async () => {
  for (const state of [{error:'Comparison failed'},{checked_at:null}]) {
    const h=harness({rows:[{...product,kind:'archive'},{...product,kind:'review',zaStock:0}],state});
    assert.equal((await h.get(true)).body.attention,false);
    const full=(await h.get()).body;
    assert.equal(full.error,state.error);
    assert.equal(full.overdue,state.checked_at===null);
    assert.equal(full.rows.length,2);
    assert.equal(full.counts['thanda-solar'].total,0);
    assert.equal(h.calls.length,0);
  }
  for (const kind of ['price','new']) {
    assert.equal((await harness({rows:[{...product,kind,zaStock:0}]}).get(true)).body.attention,true);
  }
});
test('full and summary GET use identical company counts, regardless of acknowledgement', async () => {
  const rows=[product,{...product,kind:'new',sku:'NEW'},
    {...product,kind:'review',zaStock:3,sku:'REVIEW'},
    {...product,kind:'review',zaStock:3,ignoredUntil:'2027-01-01',sku:'IGNORED'},
    {...product,kind:'archive',sku:'ARCHIVE'},
    {...product,company:'sensible-solar',kind:'new',sku:'SENSIBLE_NEW'}];
  const h=harness({rows,state:{acknowledged_signature:'current'}});
  const summary=(await h.get(true)).body,full=(await h.get()).body;
  assert.equal(summary.attention,true);
  assert.equal(full.attention,true);
  assert.deepEqual(summary.counts,full.counts);
  assert.deepEqual(full.counts,{
    'thanda-solar':{price:1,new:1,review:1,archive:1,total:3},
    'sensible-solar':{price:0,new:1,review:0,archive:0,total:1},
  });
  assert.equal(h.calls.length,0);
});

for (const [name, body] of [['single', single], ['batch', batch]]) {
  test(`${name}: plain-text Hub500 is audited as uncertain without exposing parser/internal errors`, async () => {
    const h = harness({ respond: () => new Response('Internal Server Error', { status: 500 }) });
    const result = await h.post(body);
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'UNKNOWN_OUTCOME');
    assert.match(result.body.error, /Do not repeat/);
    assert.doesNotMatch(result.body.error, /Unexpected token|Internal Server Error/);
    assert.deepEqual(h.audit.map(a => a.action), name === 'batch' ? ['batch-pending', 'batch-unknown'] : ['pending', 'unknown']);
    assert.equal(h.calls.length, 1);
  });
  test(`${name}: confirmed outcome retains the exact reviewed prices and a fresh command identity`, async () => {
    const h = harness();
    const result = await h.post(body);
    assert.equal(result.status, 200);
    assert.match(result.body.message, /Xero confirmed/);
    assert.equal(h.calls[0].company, product.company);
    const sent = name === 'batch' ? h.calls[0].payload.proposals[0] : h.calls[0].payload;
    assert.match(sent.requestId, /^[a-f0-9]{64}$/);
    assert.notEqual(sent.requestId, product.fingerprint);
    assert.equal(sent.expectedCost, product.previous);
    assert.equal(sent.cost, product.cost);
    assert.equal(sent.list, product.list);
    assert.equal(sent.observedAt, product.observedAt);
    assert.equal(h.audit[1].action, name === 'batch' ? 'batch-applied' : 'applied');
    const second = harness();
    await second.post(body);
    const another = name === 'batch' ? second.calls[0].payload.proposals[0] : second.calls[0].payload;
    assert.notEqual(sent.requestId, another.requestId, 'later legitimate price cycles must not replay an old command');
  });
}

for (const [name, respond] of [
  ['connection timeout', () => { throw new Error('internal socket details'); }],
  ['invalid success response', () => new Response('<html>proxy failure</html>')],
  ['wrong confirmed cost', () => Response.json({ Items: [{ Code: product.sku, ItemID: product.itemId, PurchaseDetails: { UnitPrice: 1 } }] })],
  ['JSON server failure', () => Response.json({ detail: 'private server exception' }, { status: 500 })],
]) test(`${name}: one attempt, no automatic retry, safe uncertain response`, async () => {
  const h = harness({ respond });
  const result = await h.post();
  assert.equal(result.body.code, 'UNKNOWN_OUTCOME');
  assert.doesNotMatch(result.body.error, /internal|private|proxy/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.audit.at(-1).action, 'unknown');
});

test('audit failure before dispatch prevents the write', async () => {
  const h = harness({ failAttempt: true });
  const result = await h.post();
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'NOT_SENT');
  assert.equal(h.calls.length, 0);
});

function newProducts(count = 2, company = 'thanda-solar') {
  return Array.from({ length: count }, (_, i) => ({ ...product, company,
    fingerprint: `new-${company}-${i}`, sku: `NEW${i}`, kind: 'new', itemId: null, previous: null,
    proposed: company === 'sensible-solar' ? 165.6 : 144.9 }));
}
const createBatch = rows => ({ action: 'apply-create-batch', fingerprints: rows.map(row => row.fingerprint) });

for (const company of ['thanda-solar', 'sensible-solar']) {
  test(`${company}: create 50 products through one audited Hub command with exact reviewed definitions`, async () => {
    const rows = newProducts(50, company);
    const h = harness({ rows });
    const result = await h.post(createBatch(rows));
    assert.equal(result.status, 200);
    assert.equal(result.body.message, 'Xero confirmed 50 new products added.');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].company, company);
    assert.equal(h.calls[0].path, 'commands/victron-create');
    const sent = h.calls[0].payload.proposals;
    assert.equal(sent.length, 50);
    assert.equal(new Set(sent.map(row => row.requestId)).size, 50);
    for (let i = 0; i < sent.length; i++) {
      assert.equal(sent[i].action, 'new');
      assert.equal(sent[i].code, rows[i].sku);
      assert.equal(sent[i].cost, rows[i].cost);
      assert.equal(sent[i].list, rows[i].list);
      assert.equal(sent[i].observedAt, rows[i].observedAt);
      assert.equal(sent[i].expectedItemId, null);
      assert.equal(sent[i].expectedCost, null);
    }
    assert.deepEqual(h.audit.map(event => event.action), ['batch-pending', 'batch-applied']);
    assert.equal(h.audit[1].details.result.Items.length, 50);
  });
}

test('Add to Xero submits one new product through the existing single-item command', async () => {
  const rows = newProducts(1);
  const h = harness({ rows });
  const result = await h.post({ action: 'apply', fingerprint: rows[0].fingerprint });
  assert.equal(result.status, 200);
  assert.equal(result.body.message, 'Xero confirmed 1 new product added.');
  assert.equal(h.calls[0].path, 'commands/victron-items');
  assert.equal(h.calls[0].payload.action, 'new');
});

test('creation batch cannot add both retail and standard packaging for one stock item', async () => {
  const rows = newProducts();
  rows[0].sku = 'PMP482305012';
  rows[1].sku = 'PMP482305012R';
  const h = harness({ rows });
  const result = await h.post(createBatch(rows));
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'INVALID_SELECTION');
  assert.match(result.body.error, /one packaging version/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.audit.length, 0);
});

for (const [name, mutate, action, status] of [
  ['changed creation proposal', rows => [...rows, { ...rows[0], fingerprint: 'old-fingerprint' }], 'apply-create-batch', 409],
  ['empty selection', () => [], 'apply-create-batch', 400],
  ['more than 50', () => newProducts(51), 'apply-create-batch', 400],
  ['duplicate selection', rows => [rows[0], rows[0]], 'apply-create-batch', 400],
  ['cost selection in creation action', () => [product], 'apply-create-batch', 409],
  ['new selection in cost action', rows => rows, 'apply-batch', 409],
  ['mixed companies', rows => [rows[0], ...newProducts(1, 'sensible-solar')], 'apply-create-batch', 409],
  ['mixed new and cost products', rows => [rows[0], product], 'apply-create-batch', 409],
]) test(`creation ${name}: rejected before audit or Hub call`, async () => {
  const rows = newProducts();
  const chosen = mutate(rows);
  const h = harness({ rows: [...rows, product, ...newProducts(1, 'sensible-solar')] });
  const result = await h.post({ action, fingerprints: chosen.map(row => row.fingerprint) });
  assert.equal(result.status, status);
  assert.equal(h.calls.length, 0);
  assert.equal(h.audit.length, 0);
});

for (const [name, responseItems] of [
  ['partial creation', items => items.slice(0, 1)],
  ['incorrect selling price', items => items.map(item => ({ ...item, SalesDetails: { UnitPrice: 1 } }))],
  ['repeated item identity', items => items.map(item => ({ ...item, ItemID: 'same-id' }))],
  ['validation error', items => items.map(item => ({ ...item, ValidationErrors: [{ Message: 'Already exists' }] }))],
]) test(`creation ${name}: recorded as uncertain with no automatic resend`, async () => {
  const rows = newProducts();
  const items = rows.map(row => ({ ItemID: `item-${row.sku}`, Code: row.sku,
    PurchaseDetails: { UnitPrice: row.proposed }, SalesDetails: { UnitPrice: row.list } }));
  const h = harness({ rows, respond: () => Response.json({ Items: responseItems(items) }) });
  const result = await h.post(createBatch(rows));
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'UNKNOWN_OUTCOME');
  assert.equal(h.calls.length, 1);
  assert.equal(h.audit.at(-1).action, 'batch-unknown');
});

for (const [name, options] of [
  ['anonymous', { user: null }], ['customer', { user: { id: 7, role: 'customer' } }],
  ['impersonated admin', { user: { id: 7, role: 'admin', impersonatedBy: 9 } }],
  ['cross origin', { origin: 'https://unrelated.invalid' }],
]) test(`creation ${name}: forbidden before stored evidence or Hub access`, async () => {
  const rows = newProducts();
  const h = harness({ ...options, rows });
  assert.equal((await h.post(createBatch(rows))).status, 403);
  assert.equal(h.schemaCalls(), 0);
  assert.equal(h.calls.length, 0);
});

test('creation audit failure prevents any write', async () => {
  const rows = newProducts();
  const h = harness({ rows, failAttempt: true });
  const result = await h.post(createBatch(rows));
  assert.equal(result.body.code, 'NOT_SENT');
  assert.equal(h.calls.length, 0);
});
for (const option of ['failOutcome', 'failRefresh']) test(`${option}: confirmed Xero success is not misreported as a failed write`, async () => {
  const h = harness({ [option]: true });
  const result = await h.post();
  assert.equal(result.status, 200);
  assert.match(result.body.message, /Xero confirmed/);
  assert.match(result.body.message, /could not/);
  assert.equal(h.calls.length, 1);
});

test('Hub validation rejection and Retry-After remain actionable and audited', async () => {
  const h = harness({ respond: () => Response.json({ detail: 'Wait 15 seconds between item actions' }, { status: 429, headers: { 'Retry-After': '60' } }) });
  const result = await h.post();
  assert.equal(result.status, 429);
  assert.equal(result.body.code, 'COMMAND_REJECTED');
  assert.match(result.body.error, /Wait 15 seconds/);
  assert.equal(result.headers.get('Retry-After'), '60');
  assert.equal(h.audit.at(-1).action, 'rejected');
});
test('Hub uncertainty guard is conveyed as uncertainty, not an ordinary retryable rejection', async () => {
  const h = harness({ respond: () => Response.json({ detail: 'An earlier operation for one of these SKUs needs reconciliation' }, { status: 409 }) });
  const result = await h.post();
  assert.equal(result.body.code, 'UNKNOWN_OUTCOME');
  assert.equal(h.audit.at(-1).action, 'unknown');
});
test('explicit Hub deferral preserves its safe reason and Retry-After without claiming an uncertain write', async () => {
  const h = harness({ respond: () => Response.json({ code: 'DEFERRED', detail: 'Wait before sending another item action' }, { status: 503, headers: { 'Retry-After': '60' } }) });
  const result = await h.post();
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'DEFERRED');
  assert.equal(result.body.error, 'Wait before sending another item action');
  assert.equal(result.headers.get('Retry-After'), '60');
  assert.equal(h.audit.at(-1).action, 'rejected');
  assert.equal(h.calls.length, 1);
});
test('changed review selection is rejected before audit or Hub dispatch', async () => {
  const h = harness({ rows: [{ ...product, fingerprint: 'changed-price' }] });
  const result = await h.post();
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'STALE_SELECTION');
  assert.equal(h.calls.length, 0);
  assert.equal(h.audit.length, 0);
});
test('mixed company batch is rejected before dispatch', async () => {
  const other = { ...product, fingerprint: 'sensible', company: 'sensible-solar' };
  const h = harness({ rows: [product, other] });
  const result = await h.post({ action: 'apply-batch', fingerprints: [product.fingerprint, other.fingerprint] });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'INVALID_SELECTION');
  assert.equal(h.calls.length, 0);
});
test('Sensible command retains its tenant and list policy inputs', async () => {
  const row = { ...product, company: 'sensible-solar', proposed: 165.6 };
  const h = harness({ rows: [row] });
  assert.equal((await h.post()).status, 200);
  assert.equal(h.calls[0].company, 'sensible-solar');
  assert.equal(h.calls[0].payload.cost, product.cost);
  assert.equal(h.calls[0].payload.list, product.list);
});
for (const [name, options] of [
  ['anonymous', { user: null }], ['customer', { user: { id: 7, role: 'customer' } }],
  ['impersonated admin', { user: { id: 7, role: 'admin', impersonatedBy: 9 } }],
  ['cross origin', { origin: 'https://unrelated.invalid' }],
]) test(`${name}: forbidden before database or Hub access`, async () => {
  const h = harness(options);
  assert.equal((await h.post()).status, 403);
  assert.equal(h.schemaCalls(), 0);
  assert.equal(h.calls.length, 0);
});
