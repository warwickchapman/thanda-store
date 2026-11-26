import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import { linkedCatalogueItem } from '../src/lib/victron-catalogue-navigation.mjs';
import { catalogueCounts } from '../src/lib/victron-catalogue-review.mjs';
import { archiveReadiness, archiveReadyRows } from '../src/lib/victron-archive-review.mjs';

// Exercise the actual page and shared navigation/readiness rules. Only React's
// state/effect scheduler and the local admin HTTP boundary are substituted.
const source = fs.readFileSync(new URL('../src/app/admin/victron-catalogue/page.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
function nodes(element) {
  if (!element || typeof element !== 'object') return [];
  return [element, ...[element.props?.children].flat(Infinity).flatMap(nodes)];
}
function text(element) {
  if (Array.isArray(element)) return element.map(text).join('');
  if (element == null || typeof element === 'boolean') return '';
  return typeof element === 'object' ? text(element.props?.children) : String(element);
}
const settle = async () => { for (let pass = 0; pass < 4; pass++) await new Promise(resolve => setImmediate(resolve)); };
async function mount(rows, { search = '', refreshedRows = rows, overdue = false, error = null, post } = {}) {
  const state = [], effects = [], calls = [];
  let cursor = 0, mounted = false, submitted = false;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = { current: initial };
      return state[index];
    },
    useEffect(callback) { if (!mounted) effects.push(callback); },
  };
  const modules = {
    react, 'react/jsx-runtime': jsx,
    '@/components/admin/admin-menu': { AdminMenu: () => null },
    '@/lib/victron-catalogue-navigation.mjs': { linkedCatalogueItem },
    '@/lib/victron-archive-review.mjs': { archiveReadiness, archiveReadyRows },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, require: name => { assert.ok(name in modules, `Unexpected import ${name}`); return modules[name]; },
    AbortController, Response, Date, Error, JSON, Event,
    window: { location: { search }, dispatchEvent: () => true },
    fetch: async (url, init) => {
      assert.equal(url, '/api/admin/victron-catalogue', 'All page reads/actions stay on the stored admin endpoint.');
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ method: init?.method || 'GET', body });
      if (init?.method === 'POST') { submitted = true; return post ? post(body) : Response.json({ message: 'Xero selling price updated.' }); }
      const savedRows = submitted ? refreshedRows : rows;
      return Response.json({ rows: savedRows, counts: catalogueCounts(savedRows), overdue, error, events: [] });
    },
  });
  const render = () => { cursor = 0; return exports.default(); };
  render(); mounted = true;
  for (const effect of effects) effect();
  await settle();
  return { get tree() { return render(); }, calls };
}
const row = (kind, fields = {}) => ({ company: 'thanda-solar', sku: 'PMP482305010', name: 'Original article',
  kind, fingerprint: `thanda:PMP482305010:${kind}`, previous: 200, proposed: 250, list: 250,
  reason: null, replaces: [], replacedBy: ['PMP482305012'], ...fields });
const find = (view, predicate) => nodes(view.tree).find(predicate);
const button = (view, label) => find(view, element => element.type === 'button' && text(element) === label);
const field = (view, label) => find(view, element => element.props?.['aria-label'] === label);
const bodyText = view => text(find(view, element => element.type === 'tbody'));
const selectCategory = (view, kind) => field(view, 'Change type').props.onChange({ target: { value: kind } });

test('selling differences are distinct from cost proposals for the same literal SKU and company', async () => {
  const rows = [row('price', { previous: 100, proposed: 120 }), row('selling')];
  const view = await mount(rows, { search: '?company=thanda-solar&kind=selling&sku=PMP482305010' });
  assert.equal(field(view, 'Change type').props.value, 'selling');
  assert.match(text(field(view, 'Change type')), /Selling prices \(1\)/);
  const head = text(find(view, element => element.type === 'thead'));
  assert.match(head, /Current Xero selling price/); assert.match(head, /Catalogue list price/); assert.match(head, /Difference/);
  assert.match(bodyText(view), /R 200.00R 250.00R 50.00 \(25.0%\)/);
  assert.match(bodyText(view), /Replaced by PMP482305012/);
  assert.ok(!bodyText(view).includes('R 120.00'));
  assert.equal(nodes(view.tree).filter(element => element.type === 'input' && element.props.type === 'checkbox').length, 1);
  assert.ok(button(view, 'Select first 1 matching selling prices'));
  assert.ok(!button(view, 'Select first 1 matching changes'), 'Selling updates use their own selection.');
  assert.equal(button(view, 'Review selling price').props.disabled, false);
  assert.deepEqual(view.calls, [{ method: 'GET', body: null }], 'Opening a selling-price link never writes to Xero.');
});

test('selling update displays exact company and before/after values before sending only its reviewed fingerprint', async () => {
  const cost = row('price', { previous: 100, proposed: 120 });
  const selling = row('selling');
  const view = await mount([cost, selling], { refreshedRows: [cost] });
  selectCategory(view, 'selling');
  button(view, 'Review selling price').props.onClick();
  const confirmation = field(view, 'Confirm selling price update');
  assert.match(text(confirmation), /Thanda · PMP482305010/);
  assert.match(text(confirmation), /Current Xero selling priceR 200.00/);
  assert.match(text(confirmation), /Catalogue list priceR 250.00/);
  assert.equal(view.calls.length, 1, 'The review control only opens the explicit confirmation.');
  await button(view, 'Update Xero selling price').props.onClick();
  assert.deepEqual(view.calls, [
    { method: 'GET', body: null },
    { method: 'POST', body: { action: 'apply-selling', fingerprint: selling.fingerprint, confirmed: true } },
    { method: 'GET', body: null },
  ]);
  assert.ok(!field(view, 'Confirm selling price update'));
  assert.match(text(view.tree), /Xero selling price updated/);
  selectCategory(view, 'price');
  assert.match(bodyText(view), /R 100.00R 120.00/);
});

test('zero is a real current selling price; blocked or stale evidence disables the selling action', async () => {
  const zero = await mount([row('selling', { previous: 0 })]);
  selectCategory(zero, 'selling');
  assert.match(bodyText(zero), /R 0.00R 250.00/);
  assert.equal(button(zero, 'Review selling price').props.disabled, false);
  for (const options of [
    { rows: [row('selling', { previous: null, reason: 'Current Xero selling price is unknown.' })] },
    { rows: [row('selling', { reviewBlocker: 'Selling is disabled in Xero.' })] },
    { rows: [row('selling')], overdue: true },
    { rows: [row('selling')], error: 'Saved Xero comparison failed.' },
  ]) {
    const view = await mount(options.rows, options);
    selectCategory(view, 'selling');
    assert.equal(button(view, 'Review selling price').props.disabled, true);
    assert.deepEqual(view.calls, [{ method: 'GET', body: null }]);
  }
});

test('uncertain single and batch selling writes clear confirmations, warn against repeating, and never retry', async () => {
  for (const batch of [false, true]) {
    for (const post of [
      async () => { throw new Error('Synthetic lost connection'); },
      async () => Response.json({ code: 'UNKNOWN_OUTCOME', error: 'Do not repeat until reconciled with Xero.' }, { status: 503 }),
    ]) {
      const view = await mount([row('selling')], { post });
      selectCategory(view, 'selling');
      if (batch) {
        button(view, 'Select first 1 matching selling prices').props.onClick();
        button(view, 'Review 1 selected selling prices').props.onClick();
        await button(view, 'Confirm selected selling price updates').props.onClick();
      } else {
        button(view, 'Review selling price').props.onClick();
        await button(view, 'Update Xero selling price').props.onClick();
      }
      assert.ok(!field(view, 'Confirm selling price update'));
      assert.ok(!field(view, 'Confirm selling price batch'));
      assert.equal(button(view, 'Review 0 selected selling prices').props.disabled, true);
      assert.match(text(view.tree), /Do not repeat/);
      assert.equal(view.calls.filter(call => call.method === 'POST').length, 1);
    }
  }
});

test('a selling batch confirms exact selected prices and never mixes company, cost or blocked rows', async () => {
  const first = row('selling');
  const second = row('selling', { sku: 'PMP482305012', fingerprint: 'second-selling', previous: 0, proposed: 500, list: 500 });
  const rows = [first, second, row('price', { previous: 100, proposed: 120 }),
    row('selling', { sku: 'BLOCKED', fingerprint: 'blocked', reviewBlocker: 'Selling disabled.' }),
    row('selling', { company: 'sensible-solar', sku: 'OTHER-COMPANY', fingerprint: 'other-selling' })];
  const view = await mount(rows);
  selectCategory(view, 'selling');
  button(view, 'Select first 2 matching selling prices').props.onClick();
  button(view, 'Review 2 selected selling prices').props.onClick();
  const confirmation = field(view, 'Confirm selling price batch');
  assert.match(text(confirmation), /Confirm 2 selling price updates for Thanda/);
  const selected = field(view, 'Selected selling price updates');
  assert.match(text(selected), /PMP482305010Original articleR 200.00R 250.00R 50.00/);
  assert.match(text(selected), /PMP482305012Original articleR 0.00R 500.00R 500.00/);
  assert.ok(!text(selected).includes('BLOCKED')); assert.ok(!text(selected).includes('OTHER-COMPANY'));
  assert.ok(!text(selected).includes('R 120.00'));
  assert.equal(view.calls.length, 1, 'Selection and review have no write side effects.');
  await button(view, 'Confirm selected selling price updates').props.onClick();
  assert.deepEqual(view.calls.find(call => call.method === 'POST').body, {
    action: 'apply-selling-batch', fingerprints: [first.fingerprint, second.fingerprint], confirmed: true,
  });
  assert.equal(view.calls.filter(call => call.method === 'POST').length, 1);
  assert.ok(!field(view, 'Confirm selling price batch'));
});

test('selling selection is capped at 50 and company changes clear the reviewed batch', async () => {
  const rows = Array.from({ length: 51 }, (_, index) => row('selling', { sku: `SKU${index}`, fingerprint: `selling-${index}` }));
  const view = await mount(rows);
  selectCategory(view, 'selling');
  button(view, 'Select first 50 matching selling prices').props.onClick();
  button(view, 'Review 50 selected selling prices').props.onClick();
  assert.equal(nodes(field(view, 'Selected selling price updates')).filter(element => element.type === 'tbody')[0].props.children.length, 50);
  field(view, 'Company').props.onChange({ target: { value: 'sensible-solar' } });
  assert.ok(!field(view, 'Confirm selling price batch'));
  assert.equal(button(view, 'Review 0 selected selling prices').props.disabled, true);
  assert.equal(view.calls.length, 1);
});

test('duplicate clicks on one selling confirmation send only one command', async () => {
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const view = await mount([row('selling')], { post: async () => response });
  selectCategory(view, 'selling');
  button(view, 'Review selling price').props.onClick();
  const submit = button(view, 'Update Xero selling price').props.onClick;
  const pending = submit();
  await submit();
  assert.equal(view.calls.filter(call => call.method === 'POST').length, 1);
  finish(Response.json({ message: 'Xero selling price updated.' }));
  await pending;
});

test('retired-zero report includes only fresh tracked literal zeroes and keeps other archive checks available', async () => {
  const archive = fields => row('archive', { previous: null, proposed: null, stock: 0, stockTracked: true,
    itemId: 'item-original', eligibleForArchiveReview: true, reason: 'Confirmed supplier retirement.', ...fields });
  const ready = archive({ sku: 'READY', fingerprint: 'ready' });
  const held = [
    archive({ sku: 'STOCKED', fingerprint: 'stocked', stock: 2 }),
    archive({ sku: 'UNKNOWN', fingerprint: 'unknown', stock: null }),
    archive({ sku: 'UNTRACKED', fingerprint: 'untracked', stockTracked: false }),
    archive({ sku: 'WAITING', fingerprint: 'waiting', eligibleForArchiveReview: false }),
    archive({ sku: 'NO-ID', fingerprint: 'no-id', itemId: null }),
  ];
  const view = await mount([ready, ...held, archive({ company: 'sensible-solar', sku: 'OTHER-COMPANY', fingerprint: 'other' })]);
  button(view, 'Retired items with zero stock (1)').props.onClick();
  assert.equal(field(view, 'Change type').props.value, 'archive');
  assert.equal(field(view, 'Archive status').props.value, 'ready');
  assert.match(bodyText(view), /READY/);
  for (const sku of ['STOCKED', 'UNKNOWN', 'UNTRACKED', 'WAITING', 'NO-ID', 'OTHER-COMPANY']) assert.ok(!bodyText(view).includes(sku));
  assert.match(text(view.tree), /1 retired item has confirmed zero tracked stock in Thanda/);
  assert.match(text(view.tree), /Archive there first, then record completion here/);
  assert.equal(button(view, 'Record completed archive').props.disabled, false);
  field(view, 'Archive status').props.onChange({ target: { value: 'all' } });
  const tableRows = nodes(find(view, element => element.type === 'tbody')).filter(element => element.type === 'tr');
  for (const item of held) {
    const tableRow = tableRows.find(element => text(element).includes(item.sku));
    assert.ok(tableRow);
    assert.equal(nodes(tableRow).find(element => element.type === 'button' && text(element) === 'Record completed archive').props.disabled, true);
  }
  assert.match(bodyText(view), /Untracked in Xero/);
  assert.deepEqual(view.calls, [{ method: 'GET', body: null }], 'Opening the retirement report only reads saved evidence.');
  for (const context of [{ overdue: true }, { error: 'Evidence unavailable.' }]) {
    const stale = await mount([ready], context);
    button(stale, 'Retired items with zero stock (0)').props.onClick();
    assert.equal(bodyText(stale), '');
    field(stale, 'Archive status').props.onChange({ target: { value: 'all' } });
    assert.equal(button(stale, 'Record completed archive').props.disabled, true);
  }
});
