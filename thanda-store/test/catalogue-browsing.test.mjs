import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import * as classification from '../src/lib/catalogue-classification.mjs';
import * as succession from '../src/lib/catalogue-succession.mjs';
import * as filters from '../src/lib/catalogue-filters.mjs';

const product = (id, supplier, name, stock = 2) => ({
  id, supplier, name, sku: `TEST-${id}`, category: 'Battery',
  stock_on_hand: stock, recommended_retail_ex_vat: 100, your_price_ex_vat: 60,
  details: { localStockOnHand: 0, xeroStockStatus: 'tracked' },
});
const products = [
  product(1, 'victron', 'Victron 300Ah battery'),
  product(2, 'renogy', 'Renogy 300Ah battery'),
  product(3, 'hubble', 'Hubble 200Ah battery'),
  product(4, 'victron', 'Unavailable 300Ah battery', 0),
  product(5, 'victron', 'Unknown 300Ah battery', null),
];
const CatalogueFilters = () => null;
const compiled = ts.transpileModule(readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;

function descendants(node) {
  if (Array.isArray(node)) return node.flatMap(descendants);
  if (!node || typeof node !== 'object') return [];
  return [node, ...descendants(node.props?.children)];
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  return node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '');
}
const brandLabel = node => text(Array.isArray(node.props.children) ? node.props.children[0] : node.props.children);
function storefront(initialQuery = '') {
  let cursor = 0;
  let query = initialQuery;
  const state = [];
  const modules = {
    'react/jsx-runtime': jsx,
    react: {
      useState(initial) {
        const index = cursor++;
        if (!(index in state)) state[index] = index === 0 ? products : index === 1 ? false
          : initial?.mine ? { mine: [products[0]], thanda: [products[1]] } : initial;
        return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
      },
      useEffect() {}, useRef: () => ({ current: null }),
    },
    'next/link': { default: () => null },
    'lucide-react': Object.fromEntries(['Package', 'ShoppingCart', 'Info', 'LogOut', 'ReceiptText', 'Menu', 'X'].map(name => [name, () => null])),
    '@/lib/utils': { formatCurrency: String },
    '@/components/product-details': { ProductDetails: () => null },
    '@/components/cart-drawer': { CartDrawer: () => null },
    '@/components/store-search': { useStoreSearch: () => ({ query, setQuery: value => { query = typeof value === 'function' ? value(query) : value; } }) },
    '@/components/catalogue-filters': { CatalogueFilters },
    '@/lib/catalogue-classification.mjs': classification,
    '@/lib/catalogue-succession.mjs': succession,
    '@/lib/catalogue-filters.mjs': filters,
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => {
    assert(Object.hasOwn(modules, name), `Unexpected dependency ${name}`);
    return modules[name];
  } });
  const render = () => { cursor = 0; return descendants(exports.default()); };
  const buttons = () => descendants(render().find(node => node.props?.['aria-label'] === 'Product brands')).filter(node => node.type === 'button');
  return {
    render,
    search(value) { query = value; },
    select(label) { buttons().find(node => brandLabel(node) === label).props.onClick(); },
    active: () => brandLabel(buttons().find(node => node.props['aria-pressed'])),
    brands: () => buttons().map(brandLabel),
    names: () => render().filter(node => node.type === 'h3').map(text),
    sidebar: () => render().find(node => node.type === CatalogueFilters).props,
  };
}

test('All is the default between Home and the dynamic supplier tabs', () => {
  const page = storefront();
  assert.deepEqual(page.brands(), ['Home', 'All', 'Victron', 'Renogy', 'Hubble']);
  assert.equal(page.active(), 'All');
  assert.equal(page.names().length, 4);
  assert(page.names().includes('Unknown 300Ah battery'));
  assert(!page.names().includes('Unavailable 300Ah battery'));
});

test('search starts across all brands and only explicit supplier choices restrict it', () => {
  const page = storefront('300ah');
  assert.deepEqual(page.names(), ['Victron 300Ah battery', 'Renogy 300Ah battery', 'Unknown 300Ah battery']);
  page.select('Victron');
  assert.deepEqual(page.names(), ['Victron 300Ah battery', 'Unknown 300Ah battery']);
  page.search('Renogy');
  assert.equal(page.active(), 'Victron');
  assert.deepEqual(page.names(), []);
  assert(page.brands().includes('All'));
  page.select('All');
  assert.deepEqual(page.names(), ['Renogy 300Ah battery']);
  page.select('Hubble');
  page.search('200ah');
  assert.deepEqual(page.names(), ['Hubble 200Ah battery']);
});

test('empty search results retain brand navigation and do not silently change selection', () => {
  const page = storefront('does-not-exist');
  assert.equal(page.active(), 'All');
  assert.deepEqual(page.names(), []);
  page.select('Renogy');
  assert.equal(page.active(), 'Renogy');
  page.search('');
  assert.deepEqual(page.names(), ['Renogy 300Ah battery']);
});

test('All retains category, availability and unavailable controls', () => {
  const page = storefront('300ah');
  assert.equal(page.sidebar().categories[0].count, 4);
  page.sidebar().onAvailability(['unavailable']);
  assert.deepEqual(page.names(), ['Unavailable 300Ah battery']);
  page.render().find(node => node.props?.role === 'switch').props.onChange({ target: { checked: false } });
  assert.equal(page.names().length, 3);
  page.sidebar().onCategory('missing-category');
  assert.deepEqual(page.names(), []);
  page.select('Renogy');
  assert.equal(page.sidebar().category, '');
  assert.deepEqual(page.names(), ['Renogy 300Ah battery']);
});

test('Home keeps favourites and searching from Home uses all brands', () => {
  const page = storefront('Renogy');
  page.select('Home');
  assert.equal(page.active(), 'Home');
  assert.deepEqual(page.names(), ['Victron 300Ah battery']);
  page.search('300ah');
  assert.equal(page.active(), 'All');
  assert.equal(page.names().length, 3);
});
