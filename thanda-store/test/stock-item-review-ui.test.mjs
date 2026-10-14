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
    if (dialog) dialog.props.ref.current = { showModal: () => shown++, close: () => closed++ };
    return tree;
  }
  return { render, calls, get changed() { return changed; }, get shown() { return shown; }, get closed() { return closed; } };
}

function button(tree, label) {
  const found = children(tree).find(node => node.type === 'button' && text(node) === label);
  assert.ok(found, `Missing button: ${label}`);
  return found;
}

test('mixed diagnostics show only LoRa rows and counts without duplicating Victron review', () => {
  const victron = Array.from({ length: 22 }, (_, index) => item(`PIN-${index}`));
  const h = harness([...victron, item('LORA-1', { supplier: 'lora' })]);
  const tree = h.render();
  assert.match(text(tree), /LoRa item review/);
  button(tree, 'Missing from Xero (1)');
  button(tree, 'Awaiting Xero sync (0)');
  button(tree, 'Previously reviewed (0)');
  const rows = children(tree).filter(node => node.type === 'li');
  assert.equal(rows.length, 1);
  assert.match(text(rows[0]), /LORA-1/);
  button(rows[0], 'Other actions');
  assert.doesNotMatch(text(tree), /PIN-|Victron|Open catalogue review|Create in Xero|Replaces|Replaced by/);
  assert.equal(h.calls.length, 0);
});

test('the review panel is hidden without LoRa records, including historical or pending Victron rows', () => {
  for (const items of [[], [
    item('PIN-1'),
    item('ASS030065051', { creationPending: true }),
    item('PIN12150500', { active: true, decision: 'do_not_stock' }),
  ]]) {
    const h = harness(items);
    assert.equal(h.render(), null);
    assert.equal(h.calls.length, 0);
  }
});

test('LoRa pending and historical reviews preserve status, notes and observation dates', () => {
  const h = harness([
    item('VIC-PENDING', { creationPending: true }),
    item('VIC-REVIEWED', { active: true, decision: 'do_not_stock' }),
    item('LORA-PENDING', { supplier: 'lora', creationPending: true }),
    item('LORA-REVIEWED', { supplier: 'lora', active: true, decision: 'do_not_stock', note: 'Local purchasing decision', reviewedAt: '2026-10-07T10:00:00Z' }),
  ]);
  let tree = h.render();
  button(tree, 'Missing from Xero (0)');
  button(tree, 'Awaiting Xero sync (1)').props.onClick();
  tree = h.render();
  assert.match(text(tree), /normal Xero stock import finds them/);
  assert.match(text(tree), /LORA-PENDING/);
  assert.doesNotMatch(text(tree), /VIC-PENDING|VIC-REVIEWED/);
  assert.match(text(tree), /Last saved Xero observation: .*SAST/);
  button(tree, 'Previously reviewed (1)').props.onClick();
  tree = h.render();
  assert.match(text(tree), /This does not mean they are archived in Xero/);
  assert.match(text(tree), /Saved purchasing decision: do not stock — Local purchasing decision/);
  assert.match(text(tree), /reviewed .*SAST/);
  assert.match(text(tree), /LORA-REVIEWED/);
  assert.doesNotMatch(text(tree), /VIC-PENDING|VIC-REVIEWED|Open catalogue review|Create in Xero/);
  button(tree, 'Other actions');
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
