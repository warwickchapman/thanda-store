import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import { linkedCatalogueItem } from '../src/lib/victron-catalogue-navigation.mjs';
import { catalogueCounts } from '../src/lib/victron-catalogue-review.mjs';
import { catalogueReviewUrl } from '../src/lib/stock-review-view.mjs';

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
async function mount(rows, search, refreshedRows = rows) {
  const state = [], effects = [], calls = [];
  let cursor = 0, mounted = false;
  let refreshed = false;
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
  const modules = { react, 'react/jsx-runtime': jsx,
    '@/components/admin/admin-menu': { AdminMenu: () => null },
    '@/lib/victron-catalogue-navigation.mjs': { linkedCatalogueItem },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => {
    assert.ok(name in modules, `Unexpected import ${name}`);
    return modules[name];
  }, AbortController, Response, Date, Error, JSON, Event, window: { location: { search }, dispatchEvent: () => true },
  fetch: async (url, init) => {
    calls.push({ url, method: init?.method || 'GET' });
    assert.equal(url, '/api/admin/victron-catalogue');
    if (init?.method === 'POST') {
      assert.equal(JSON.parse(init.body).action, 'refresh', 'only an explicit saved comparison is simulated');
      refreshed = true;
      return Response.json({ message: 'Compared saved records.' });
    }
    const savedRows = refreshed ? refreshedRows : rows;
    return Response.json({ rows: savedRows, counts: catalogueCounts(savedRows), overdue: false, events: [] });
  } });
  const render = () => { cursor = 0; return exports.default(); };
  render(); mounted = true;
  for (const effect of effects) effect();
  for (let pass = 0; pass < 4; pass++) await new Promise(resolve => setImmediate(resolve));
  return { get tree() { return render(); }, calls };
}
const row = (company, sku, fields = {}) => ({ company, sku, fingerprint: `${company}:${sku}`, name: sku,
  kind: 'review', zaStock: 0, reason: '120V-only model: South African eligibility requires review.',
  replaces: [], replacedBy: [], ...fields });

test('Data health opens uncounted exact Thanda review rows without retail/family substitutions or commands', async () => {
  const sku = 'PMP482305010';
  const url = new URL(catalogueReviewUrl(sku), 'https://store.thanda.solar');
  const h = await mount([
    row('thanda-solar', sku, { replacedBy: ['PMP482305012'] }),
    row('thanda-solar', `${sku}R`, { name: 'Retail sibling' }),
    row('thanda-solar', 'PMP482305012', { name: 'Successor' }),
    row('sensible-solar', sku, { name: 'Other company proposal', zaStock: 5 }),
  ], url.search);
  const all = nodes(h.tree);
  assert.equal(all.find(node => node.props?.['aria-label'] === 'Company').props.value, 'thanda-solar');
  const category = all.find(node => node.props?.['aria-label'] === 'Change type');
  assert.equal(category.props.value, 'review');
  assert.match(text(category), /Needs review \(0\)/);
  assert.equal(all.find(node => node.props?.['aria-label'] === 'Find product').props.value, sku);
  const body = text(all.find(node => node.type === 'tbody'));
  assert.match(body, /Silenced/);
  assert.match(body, /Replaced by PMP482305012/);
  assert.ok(!body.includes('Retail sibling'));
  assert.ok(!body.includes('Successor'));
  assert.ok(!body.includes('Other company proposal'));
  assert.ok(!all.some(node => node.type === 'button' && text(node) === 'Add to Xero'));
  assert.deepEqual(h.calls, [{ url: '/api/admin/victron-catalogue', method: 'GET' }]);
});
test('ignored and archive proposals select their category; absent exact rows never claim Xero presence', async () => {
  for (const kind of ['price', 'new', 'review', 'archive']) {
    const selected = linkedCatalogueItem('?company=sensible-solar&sku=PIN121250500', [row('sensible-solar', 'PIN121250500', { kind, ignoredUntil: '2027-01-01' })]);
    assert.deepEqual(selected, { company: 'sensible-solar', sku: 'PIN121250500', kind });
  }
  const h = await mount([row('thanda-solar', 'PMP482305010R')], '?company=thanda-solar&sku=PMP482305010');
  assert.match(text(h.tree), /no pending proposal for this exact SKU/);
  assert.match(text(h.tree), /does not confirm that the item is present in Xero/);
  assert.equal(text(nodes(h.tree).find(node => node.type === 'tbody')), '');
  assert.equal(linkedCatalogueItem('?company=unknown&sku=PMP482305010', []), null);
  assert.equal(linkedCatalogueItem('?company=thanda-solar&sku=%3Cscript%3E', []), null);
});
test('an explicit comparison reveals a newly available linked proposal, while manual filters are respected', async () => {
  const sku = 'PMP482305012';
  const query = `?company=thanda-solar&sku=${sku}`;
  const next = [row('thanda-solar', sku, { kind: 'new', reason: null, proposed: 100, list: 200 })];
  const refresh = h => nodes(h.tree).find(node => node.type === 'button' && text(node) === 'Compare saved records').props.onClick();
  const category = h => nodes(h.tree).find(node => node.props?.['aria-label'] === 'Change type');
  const h = await mount([], query, next);
  assert.equal(category(h).props.value, 'review');
  await refresh(h);
  assert.equal(category(h).props.value, 'new');
  assert.match(text(nodes(h.tree).find(node => node.type === 'tbody')), /Add to Xero/);
  assert.deepEqual(h.calls.map(call => call.method), ['GET', 'POST', 'GET']);

  const manual = await mount([], query, next);
  category(manual).props.onChange({ target: { value: 'archive' } });
  await refresh(manual);
  assert.equal(category(manual).props.value, 'archive');
  assert.match(text(manual.tree), /saved proposal is in New products/);
});
