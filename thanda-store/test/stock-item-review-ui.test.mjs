import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import * as views from '../src/lib/stock-review-view.mjs';

const source = fs.readFileSync(new URL('../src/components/admin/stock-item-review.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
} }).outputText;

function item(sku, overrides = {}) {
  return {
    supplier: 'victron', sku, name: `Product ${sku}`, xeroStatus: 'missing',
    decision: null, active: false, note: '', reviewedAt: null,
    observedAt: '2026-10-08T08:00:00Z', family: sku, familySkus: [sku],
    replaces: [], replacedBy: [], ...overrides,
  };
}

function children(node) {
  if (Array.isArray(node)) return node.flatMap(children);
  if (!node || typeof node !== 'object') return [];
  if (typeof node.type === 'function') return children(node.type(node.props));
  return [node, ...children(node.props?.children)];
}

function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'object') {
    return typeof node.type === 'function' ? text(node.type(node.props)) : text(node.props?.children);
  }
  return String(node);
}

function harness(items) {
  const slots = [], calls = [];
  let cursor = 0, changed = 0, shown = 0, closed = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
  };
  const modules = {
    react, 'react/jsx-runtime': jsx,
    'next/link': props => jsx.jsx('a', props),
    '@/lib/stock-review-view.mjs': views,
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, require(name) { assert.ok(name in modules, `Unexpected import: ${name}`); return modules[name]; },
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return Response.json({ message: 'Saved review.' });
    }, Date, String, Error, JSON,
  });
  function render() {
    cursor = 0;
    const tree = exports.StockItemReview({ items, onChanged: () => changed++ });
    const dialog = children(tree).find(node => node.type === 'dialog');
    dialog.props.ref.current = { showModal: () => shown++, close: () => closed++ };
    return tree;
  }
  return { render, calls, get changed() { return changed; }, get shown() { return shown; }, get closed() { return closed; } };
}

function button(tree, label) {
  const found = children(tree).find(node => node.type === 'button' && text(node) === label);
  assert.ok(found, `Missing button: ${label}`);
  return found;
}

test('Victron diagnostics link the literal SKU to Thanda catalogue without creation or decision controls', () => {
  const h = harness([item('PMP482305010', { name: 'MultiPlus', replacedBy: ['PMP482305012'] })]);
  const tree = h.render();
  const row = children(tree).find(node => node.type === 'li');
  const link = children(row).find(node => node.type === 'a');
  assert.equal(text(link), 'Open catalogue review');
  const target = new URL(link.props.href, 'https://store.example');
  assert.equal(target.pathname, '/admin/victron-catalogue');
  assert.equal(target.searchParams.get('company'), 'thanda-solar');
  assert.equal(target.searchParams.get('sku'), 'PMP482305010');
  assert.match(text(row), /Replaced by PMP482305012/);
  assert.equal(children(row).filter(node => node.type === 'button').length, 0);
  assert.doesNotMatch(text(tree), /Create in Xero|Other actions|Mark as discontinued|Review price preview/);
  assert.equal(h.calls.length, 0);
});

test('pending and historical Victron rows remain read-only diagnostics with catalogue navigation', () => {
  const h = harness([
    item('ASS030065051', { creationPending: true }),
    item('PIN12150500', { active: true, decision: 'do_not_stock', note: 'Local purchasing decision', reviewedAt: '2026-10-07T10:00:00Z' }),
  ]);
  let tree = h.render();
  button(tree, 'Awaiting Xero sync (1)').props.onClick();
  tree = h.render();
  assert.match(text(tree), /normal Xero stock import finds them/);
  assert.equal(children(tree).filter(node => node.type === 'a' && text(node) === 'Open catalogue review').length, 1);
  assert.doesNotMatch(text(tree), /Other actions|Create in Xero/);
  button(tree, 'Previously reviewed (1)').props.onClick();
  tree = h.render();
  assert.match(text(tree), /This does not mean they are archived in Xero/);
  assert.match(text(tree), /Saved purchasing decision: do not stock — Local purchasing decision/);
  assert.match(text(tree), /reviewed/);
  assert.equal(children(tree).filter(node => node.type === 'a' && text(node) === 'Open catalogue review').length, 1);
  assert.doesNotMatch(text(tree), /Undo saved decision|Do not stock|Other actions|Create in Xero/);
  assert.equal(h.calls.length, 0);
});

test('LoRa keeps saved-list checks and local do-not-stock decisions', async () => {
  const h = harness([item('LORA-1', { supplier: 'lora' })]);
  let tree = h.render();
  assert.doesNotMatch(text(tree), /Open catalogue review/);
  button(tree, 'Other actions').props.onClick();
  tree = h.render();
  assert.equal(h.shown, 1);
  button(tree, 'Check saved Xero list').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls[0].url, '/api/admin/data-health/stock-review');
  assert.deepEqual(h.calls[0].body, { supplier: 'lora', sku: 'LORA-1', action: 'check', note: '' });
  assert.equal(h.changed, 1);
  tree = h.render();
  button(tree, 'Do not stock').props.onClick();
  tree = h.render();
  const note = children(tree).find(node => node.type === 'textarea');
  note.props.onChange({ target: { value: 'Not required' } });
  tree = h.render();
  button(tree, 'Save decision').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls[1].body, { supplier: 'lora', sku: 'LORA-1', action: 'do_not_stock', note: 'Not required' });
  assert.equal(h.changed, 2);
});

test('LoRa saved decisions can still be undone locally', async () => {
  const h = harness([item('LORA-2', { supplier: 'lora', active: true, decision: 'do_not_stock', note: 'Not required' })]);
  let tree = h.render();
  button(tree, 'Previously reviewed (1)').props.onClick();
  tree = h.render();
  button(tree, 'Other actions').props.onClick();
  tree = h.render();
  button(tree, 'Undo saved decision').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls[0].body, { supplier: 'lora', sku: 'LORA-2', action: 'undo', note: '' });
  assert.equal(h.changed, 1);
});
