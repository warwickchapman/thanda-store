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
function storefront(initialQuery = '', catalogue = products) {
  let cursor = 0;
  let query = initialQuery;
  const state = [];
  const modules = {
    'react/jsx-runtime': jsx,
    react: {
      useState(initial) {
        const index = cursor++;
        if (!(index in state)) state[index] = index === 0 ? catalogue : index === 1 ? false
          : initial?.mine ? { mine: [catalogue[0]], thanda: [catalogue[1]] } : initial;
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

test('Enertec uses one supplier tab and three list categories without an implied retail list price', () => {
  const previewProducts = [
    ['Energizer', 'Energizer 612 battery'], ['Marine & Leisure', 'Discover AGM battery'], ['CTEK', 'CTEK MXS 5.0 charger'],
  ].map(([category, name], index) => ({
    ...product(index + 20, 'enertec', name, null), category,
    details: { supplierStockStatus: 'unknown', supplierStockLabel: 'Enertec' },
  }));
  const page = storefront('', [...products, ...previewProducts]);
  assert.deepEqual(page.brands(), ['Home', 'All', 'Victron', 'Renogy', 'Hubble', 'Enertec']);
  page.select('Enertec');
  assert.deepEqual(Array.from(page.sidebar().categories, ({ label }) => label), ['All categories', 'CTEK', 'Energizer', 'Marine & Leisure']);
  page.sidebar().onCategory('CTEK');
  assert.deepEqual(page.names(), ['CTEK MXS 5.0 charger']);
  assert(!page.render().some(node => node.type === 'span' && text(node) === 'List Price Excl. VAT'));
  const add = page.render().find(node => node.type === 'button' && node.props.title === 'Confirm availability with sales');
  assert.equal(add.props.disabled, true);
  assert(page.render().some(node => node.type === 'div' && text(node) === 'Stock generally available, confirm on request'));
});

test('products without a dealer price cannot be added even if stock is known', () => {
  const page = storefront('', [{ ...product(40, 'enertec', 'CTEK price on request'), your_price_ex_vat: null }]);
  const add = page.render().find(node => node.type === 'button' && node.props.title === 'Price on request');
  assert.equal(add.props.disabled, true);
});

test('combined replacement stock is explained in the listing and its product drawer', () => {
  const codes = ['PMP482305010', 'PMP482305012'];
  const family = { ...product(70, 'victron', 'Current MultiPlus'), sku: codes[1], stock_on_hand: 9,
    details: { localStockOnHand: 5, xeroStockStatus: 'tracked', stockFamilySkus: codes } };
  const page = storefront('', [family]);
  const explanation = `Stock includes replacement codes: ${codes.join(', ')}.`;
  assert(page.render().some(node => node.type === 'div' && text(node) === explanation));
  assert(page.render().some(node => node.type === 'span' && text(node) === '5 in stock (KZN)'));
  page.render().find(node => node.type === 'button' && text(node) === 'View details').props.onClick();
  const drawer = page.render().find(node => node.props?.stock && node.props.product === family);
  assert(drawer);
  assert(Array.from(drawer.props.stock).includes(explanation));
});

test('an unknown replacement family remains unknown even if an old quantity is retained', () => {
  const family = { ...product(71, 'victron', 'Incomplete MultiPlus stock', 9),
    details: { localStockOnHand: 3, xeroStockStatus: 'tracked',
      stockFamilyLocalStatus: 'unknown', stockFamilySupplierStatus: 'unknown',
      stockFamilySkus: ['PMP482305010', 'PMP482305012'] } };
  const page = storefront('', [family]);
  assert(page.render().some(node => node.type === 'div' && text(node) === 'Thanda stock unknown'));
  assert(!page.render().some(node => node.type === 'div' && text(node).startsWith('Available now:')));
  assert(page.render().some(node => node.type === 'button' && node.props.title === 'Confirm availability with sales' && node.props.disabled));
});

test('partially known replacement stock is a labelled lower bound in badges, stock lines and filters', () => {
  const family = { ...product(72, 'victron', 'Partially known MultiPlus stock', 9),
    details: { localStockOnHand: 3, xeroStockStatus: 'missing', supplierStockStatus: 'unknown',
      stockFamilyLocalStatus: 'partial', stockFamilySupplierStatus: 'partial',
      stockFamilySkus: ['PMP482305010', 'PMP482305012'] } };
  const page = storefront('', [family]);
  assert(page.render().some(node => node.type === 'span' && text(node) === 'At least 3 in stock (KZN)'));
  assert(page.render().some(node => node.type === 'div' && text(node) === 'Available now: at least 3 in stock (KZN)'));
  assert(page.render().some(node => node.type === 'div' && text(node) === 'Victron Warehouse ZA: at least 9 in stock (3-5 working days)'));
  assert.equal(page.sidebar().availabilityOptions.find(option => option.key === 'thanda').count, 1);
  assert.equal(page.sidebar().availabilityOptions.find(option => option.key === 'supplier').count, 1);
});
