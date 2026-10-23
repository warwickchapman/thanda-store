import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';

const compiled = ts.transpileModule(readFileSync(new URL('../src/app/admin/data-health/page.tsx', import.meta.url), 'utf8')
  + '\nexport { NextStep, Recovery };', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
const source = (overrides = {}) => ({
  id: 'thanda', label: 'Thanda stock', mode: 'scheduled', supplier: null,
  status: 'current', message: 'Stored stock is current.', feedStatus: 'current', feedMessage: 'The saved inventory import is current.',
  observedAt: '2026-10-23T10:00:00Z', lastAttemptAt: '2026-10-23T10:01:00Z', lastSuccessAt: '2026-10-23T10:01:01Z',
  totalCount: 20, missingCount: 0, staleCount: 0, actionableIssueCount: 0,
  awaitingStockImportCount: 0, lifecycleCount: 0, lifecycleActionCount: 0, issues: [], recovery: [], ...overrides,
});

function content(node, visibleOnly = false) {
  if (Array.isArray(node)) return node.map(child => content(child, visibleOnly)).join('');
  if (!node || typeof node !== 'object') return String(node ?? '');
  if (visibleOnly && node.type === 'details' && !node.props.open) {
    const children = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
    return children.filter(child => child?.type === 'summary').map(child => content(child, visibleOnly)).join('');
  }
  return content(node.props?.children, visibleOnly);
}
function descendants(node) {
  if (Array.isArray(node)) return node.flatMap(descendants);
  return !node || typeof node !== 'object' ? [] : [node, ...descendants(node.props?.children)];
}
function pageFor(sources, { refresh = null, victron = null, response = null } = {}) {
  const state = [victron, sources, [], '2026-10-23T10:02:00Z', '', false, 0, refresh];
  const refs = [];
  const calls = [];
  const timers = [];
  let hooks = 0;
  let refCursor = 0;
  let nested = false;
  let effects = [];
  const modules = {
    'react/jsx-runtime': jsx,
    react: {
      useState(initial) {
        if (nested) return [initial, () => {}];
        const index = hooks++;
        if (!(index in state)) state[index] = initial;
        return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
      },
      useRef(initial) { const index = refCursor++; return refs[index] ||= { current: initial }; },
      useEffect(callback) { if (!nested) effects.push(callback); },
    },
    'next/link': { __esModule: true, default: props => jsx.jsx('a', props) },
    '@/components/admin/stock-item-review': { StockItemReview: () => null },
    '@/components/admin/admin-menu': { AdminMenu: () => null },
    '@/components/admin/victron-api-activity': { VictronApiActivity: () => jsx.jsx('button', { children: 'Retry catalogue' }) },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, AbortController,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => response || { sources, stockRefresh: refresh, victron } };
    },
    setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout: timer => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
    require: name => { assert(Object.hasOwn(modules, name), `Unexpected dependency ${name}`); return modules[name]; },
  });
  function expand(node) {
    if (Array.isArray(node)) return node.map(expand);
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      nested = true;
      const rendered = node.type(node.props);
      nested = false;
      return expand(rendered);
    }
    return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
  }
  const render = () => { hooks = 0; refCursor = 0; effects = []; return expand(exports.default()); };
  return {
    render, calls, timers,
    runProgressCheck() { render(); return effects[1](); },
    async load() { render(); effects[0](); await new Promise(resolve => setImmediate(resolve)); },
  };
}

test('confirmed additions awaiting stock import are a waiting state, not another product worklist', () => {
  const page = pageFor([source({ status: 'missing', message: 'Old aggregate missing message', missingCount: 1,
    awaitingStockImportCount: 1, awaitingStockImports: [{ sku: 'NEW-PRODUCT', name: 'New product', createdAt: '2026-10-23T10:01:00Z' }] })]);
  const tree = page.render();
  const visible = content(tree, true);
  assert.match(visible, /Waiting for stock import \(1\)/);
  assert.match(visible, /Do not add them again/);
  assert.match(visible, /No other action is needed/);
  assert(!visible.includes('Old aggregate missing message'));
  assert(!visible.includes('NEW-PRODUCT'));
  assert(!visible.includes('record needs checking'));
  assert(!visible.includes('Ask the Store maintainer to check the first complete import'));
  assert(!descendants(tree).some(node => node.type === 'button' && /Create|Add to Xero/.test(content(node))));
});

test('real missing stock records state the owner and remedy without offering a duplicate Victron creation action', () => {
  const page = pageFor([source({ status: 'missing', missingCount: 1, actionableIssueCount: 1,
    issues: [{ sku: 'REQUIRED-SKU', name: 'Required inventory', reason: 'Required inventory article is missing',
      remedy: 'Check the inventory record and article code with the bookkeeper.', owner: 'bookkeeper',
      actionLabel: 'Xero connection settings', actionUrl: '/admin/settings' }] })]);
  const tree = page.render();
  assert.match(content(tree, true), /1 record needs checking/);
  assert.match(content(tree, true), /Stock records to check \(1\)/);
  assert(!content(tree, true).includes('REQUIRED-SKU'), 'record diagnostics start collapsed');
  assert.match(content(tree), /Who can help: your bookkeeper/);
  assert.match(content(tree), /Check the inventory record and article code/);
  assert(descendants(tree).some(node => node.type === 'a' && node.props.href === '/admin/settings'));
});

test('supplier catalogue removals route to catalogue review and do not claim removal from Xero', () => {
  const page = pageFor([source({ id: 'victron', label: 'Victron supplier stock', lifecycleCount: 2, lifecycleActionCount: 2,
    lifecycleItems: [{ sku: 'RETIRED-SUPPLIER-SKU', name: 'Previous product' }],
    lifecycleReviewUrl: '/admin/victron-catalogue?company=thanda-solar&kind=archive' })]);
  const tree = page.render();
  const visible = content(tree, true);
  assert.match(visible, /absent from the last complete E-Order catalogue/);
  assert(!visible.includes('no longer in the saved Xero'));
  assert(!visible.includes('RETIRED-SUPPLIER-SKU'));
  assert(descendants(tree).some(node => node.type === 'a' && node.props.href.includes('kind=archive')));
  assert.match(visible, /1 source needs attention/);
});

test('Renogy removals require confirmation rather than an invented end-of-life or Xero archive decision', () => {
  const page = pageFor([source({ id: 'renogy', label: 'Renogy stock', lifecycleCount: 1, lifecycleReviewUrl: '/admin/products' })]);
  const tree = page.render();
  assert.match(content(tree, true), /Absence does not confirm end of life/);
  assert.match(content(tree, true), /No stock-data action is needed for these catalogue absences/);
  assert(!content(tree, true).includes('source needs attention'));
  assert(!descendants(tree).some(node => node.type === 'a' && node.props.href === '/admin/products'), 'known supplier absence does not recreate a Renogy management queue');
});

test('eleven supplier absences with no pending archive work are information only', () => {
  const page = pageFor([source({ id: 'victron', lifecycleCount: 11, lifecycleActionCount: 0 })]);
  const visible = content(page.render(), true);
  assert.match(visible, /11 products are absent from the last complete E-Order catalogue/);
  assert.match(visible, /No stock-data action is needed for these catalogue absences/);
  assert(!visible.includes('source needs attention'));
  assert(!visible.includes('11 catalogue decisions'));
  assert(!visible.includes('archive review'));
});

test('eleven supplier absences with five pending archive candidates show five actions', () => {
  const page = pageFor([source({ id: 'victron', lifecycleCount: 11, lifecycleActionCount: 5,
    lifecycleReviewUrl: '/admin/victron-catalogue?company=thanda-solar&kind=archive' })]);
  const tree = page.render();
  const visible = content(tree, true);
  assert.match(visible, /11 products are absent/);
  assert.match(visible, /5 products still need archive review/);
  assert(!visible.includes('11 products still need'));
  assert(!visible.includes('11 catalogue decisions'));
  assert.match(visible, /1 source needs attention/);
  assert.equal(descendants(tree).filter(node => node.type === 'a' && node.props.href.includes('kind=archive')).length, 1);
});

test('unknown catalogue cleanup status is explicit without inventing a pending count or claiming all work complete', () => {
  const page = pageFor([source({ id: 'victron', lifecycleCount: 11, lifecycleActionCount: null,
    lifecycleReviewMessage: 'Compare saved records to check whether any archive review remains.' })]);
  const visible = content(page.render(), true);
  assert.match(visible, /Catalogue cleanup status has not been confirmed/);
  assert.match(visible, /Compare saved records/);
  assert(!visible.includes('source needs attention'));
  assert(!visible.includes('11 catalogue decisions'));
  assert(!visible.includes('No action needed'));
  assert(!visible.includes('No stock-data action is needed'));
});

test('failed feed remains actionable while product additions are awaiting import', () => {
  const page = pageFor([source({ feedStatus: 'error', feedMessage: 'Last stock import failed.', awaitingStockImportCount: 1 })]);
  const visible = content(page.render(), true);
  assert.match(visible, /1 source needs attention/);
  assert.match(visible, /Last stock import failed/);
  assert.match(visible, /Waiting for stock import \(1\)/);
  assert.match(visible, /send the diagnostic report to the Store maintainer/);
  assert(!visible.includes('No other action is needed'));
});

test('an incomplete inventory assessment remains actionable even when the stock feed is current', () => {
  const page = pageFor([source({ inventoryScopeMessage: 'Saved quote evidence is too old to assess inventory requirements.' })]);
  const tree = page.render();
  const visible = content(tree, true);
  assert.match(visible, /1 source needs attention/);
  assert.match(visible, /Inventory requirement check is incomplete/);
  assert(!visible.includes('No action needed'));
  assert(!visible.includes('Saved quote evidence is too old'));
  assert.match(content(tree), /Saved quote evidence is too old/);
});

test('cached supplier pause deadlines stay visible and replace misleading next-scheduled-update advice', () => {
  const page = pageFor([source({ id: 'victron', feedStatus: 'error', feedMessage: 'The latest source update failed.' })], {
    victron: { checkedAt: '2026-10-23T10:00:00Z', states: [
      { scope: 'catalogue', blocked_until: '2026-10-23T12:00:00Z' },
      { scope: 'orders', blocked_until: '2026-10-23T13:00:00Z' },
    ] },
  });
  const visible = content(page.render(), true);
  assert.match(visible, /Supplier checks paused until/);
  assert.match(visible, /14:00/);
  assert(!visible.includes('15:00'), 'a catalogue pause does not borrow the orders deadline');
  assert.match(visible, /Use Check status after this time/);
  assert(!visible.includes('If the update is still overdue or failed'));
});

test('source roles, update cadence and collapsed diagnostics make the next check clear', () => {
  const page = pageFor([source(), source({ id: 'victron', label: 'Victron stock' })], { victron: {} });
  const tree = page.render();
  const visible = content(tree, true);
  assert.match(visible, /Thanda stock in Xero/);
  assert.match(visible, /Victron supplier stock in ZA/);
  assert.match(visible, /Sensible’s Xero catalogue is separate/);
  assert.match(visible, /Stock imports run every 30 minutes/);
  assert.match(visible, /checks run every four hours/);
  assert(!visible.includes('Oldest source observation'));
  assert(!visible.includes('Retry catalogue'));
  assert.match(content(tree), /Oldest source observation/);
  assert.match(content(tree), /Retry catalogue/);
});

test('pending stock updates recheck only local status, at most three times', async () => {
  const page = pageFor([source()], { refresh: { pending: true, requestedAt: null, lastAttemptAt: null } });
  await page.load();
  for (let index = 0; index < 3; index++) {
    page.runProgressCheck();
    const timer = page.timers.shift();
    assert.equal(timer.delay, 45_000);
    timer.callback();
    await page.load();
  }
  page.runProgressCheck();
  assert.equal(page.timers.length, 0);
  assert.equal(page.calls.length, 4);
  assert(page.calls.every(call => call.url === '/api/admin/data-health' && !call.options.method));
  assert(page.calls.every(call => call.options.cache === 'no-store'));
});

test('a completed update stops progress checks and an empty response does not claim healthy feeds', async () => {
  const page = pageFor([source()]);
  page.runProgressCheck();
  assert.equal(page.timers.length, 0);
  const empty = pageFor([], { response: { sources: [] } });
  await empty.load();
  const tree = empty.render();
  assert(descendants(tree).some(node => node.props.role === 'alert'));
  assert(!content(tree, true).includes('Scheduled updates are current'));
});
