import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveCatalogueAttributes, catalogueFacets, matchesCatalogueFilters, productAvailability } from '../src/lib/catalogue-filters.mjs';
import { upsertProduct } from '../scripts/product-sync-lib.mjs';

const product = (name, category, details = {}) => ({ name, category, supplier: 'victron', details, stock_on_hand: 0 });
const attrs = (name, category, details) => deriveCatalogueAttributes(product(name, category, details)).attributes;

test('reviewed Victron inverter names keep apparent power separate from watts', () => {
  assert.deepEqual(attrs('MultiPlus-II 48/3000/35-32 230V', 'Inverters and chargers'), {
    range: ['MultiPlus-II'], batteryVoltage: ['48 V'], power: ['3000 VA'], acVoltage: ['230 V'],
  });
  assert.deepEqual(attrs('Quattro 24/5000/120-100/100 120VAC', 'Inverters and chargers').acVoltage, ['120 V']);
  assert.deepEqual(attrs('Cover for MultiPlus-II 48/3000 230V', 'Inverters and chargers'), {});
});

test('MPPT pair describes PV voltage and current, never assumed battery compatibility', () => {
  assert.deepEqual(attrs('SmartSolar MPPT 100/50', 'Solar chargers'), { maxPvVoltage: ['100 V'], chargeCurrent: ['50 A'] });
  assert.deepEqual(attrs('BlueSolar MPPT 150/35 battery voltage: 12/24/48V', 'Solar chargers').batteryVoltage, ['12 V', '24 V', '48 V']);
});

test('450 V includes both MPPT RS outputs and solar RS inverters, including the cached predecessor', () => {
  const rows = [
    { ...product('SmartSolar MPPT RS 450/100-MC4', 'Solar chargers'), sku: 'SCC145110512' },
    { ...product('SmartSolar MPPT RS 450/200-MC4', 'Solar chargers'), sku: 'SCC145120512' },
    { ...product('SmartSolar MPPT RS 450/200-MC4 *If 0, order SCC145120512*', 'Solar chargers'), sku: 'SCC145120510' },
    { ...product('Multi RS Solar 48/6000/100-450/100', 'Inverter Chargers'), sku: 'PMR482602020' },
    { ...product('Inverter RS 48/6000 230V Smart Solar', 'Inverters'), sku: 'PIN482601000' },
    { ...product('Inverter RS 48/6000 230V Smart', 'Inverters'), sku: 'PIN482600000' },
  ].map(p => ({ ...p, catalogue_attributes: deriveCatalogueAttributes(p).attributes }));
  assert.deepEqual(rows[0].catalogue_attributes.chargeCurrent, ['100 A']);
  assert.deepEqual(rows[1].catalogue_attributes.chargeCurrent, ['200 A']);
  assert.equal(rows[0].catalogue_attributes.batteryVoltage, undefined);
  assert.deepEqual(rows.filter(p => matchesCatalogueFilters(p, { maxPvVoltage: ['450 V'] })).map(p => p.sku),
    ['SCC145110512', 'SCC145120512', 'SCC145120510', 'PMR482602020', 'PIN482601000']);
  assert.deepEqual(catalogueFacets(rows).find(f => f.key === 'maxPvVoltage').options, [{ value: '450 V', count: 5 }]);
  assert.equal(rows[5].catalogue_attributes.maxPvVoltage, undefined);
});

test('RS Solar manufacturer fallback excludes accessories and remains subordinate to supplier specifications', () => {
  assert.deepEqual(attrs('SmartSolar MPPT RS 450/100-Tr', 'Solar chargers').maxPvVoltage, ['450 V']);
  assert.deepEqual(attrs('Inverter RS Smart Solar 48/6000', 'Inverters').maxPvVoltage, ['450 V']);
  assert.equal(attrs('Cover for Multi RS Solar 48/6000', 'Inverter Chargers').maxPvVoltage, undefined);
  assert.equal(attrs('Multi RS Solar 48/6000 replacement display', 'Inverter Chargers').maxPvVoltage, undefined);
  assert.equal(attrs('SmartSolar MPPT RS 450/100 remote display', 'Solar chargers').maxPvVoltage, undefined);
  assert.equal(deriveCatalogueAttributes({ ...product('Multi RS Solar 48/6000', 'Inverters'), supplier: 'other' }).attributes.maxPvVoltage, undefined);
  const derived = deriveCatalogueAttributes(product('Multi RS Solar 48/6000/100-450/100', 'Inverter Chargers', {
    technicalData: { 'Maximum DC PV voltage': '450 V' },
  }));
  assert.equal(derived.sources.maxPvVoltage, 'supplier specification: Maximum DC PV voltage');
});

test('explicit supplier specifications override name parsing and multi-voltage products match every voltage', () => {
  const derived = deriveCatalogueAttributes(product('SmartSolar MPPT 100/50', 'Solar chargers', {
    technicalData: [{ name: 'Battery voltage', value: '12/24/48 V' }, { label: 'Rated charge current', value: '45 A' }],
  }));
  assert.deepEqual(derived.attributes.chargeCurrent, ['45 A']);
  assert.match(derived.sources.chargeCurrent, /^supplier specification:/);
  const p = { catalogue_attributes: derived.attributes };
  for (const voltage of ['12 V', '24 V', '48 V']) assert.equal(matchesCatalogueFilters(p, { batteryVoltage: [voltage] }), true);
  assert.equal(matchesCatalogueFilters(p, { batteryVoltage: ['36 V'] }), false);
});

test('battery, panel and cable filters preserve units and leave missing or ambiguous facts unset', () => {
  assert.deepEqual(attrs('12.8V 100Ah Lithium Battery', 'Batteries'), { batteryVoltage: ['12.8 V'], capacity: ['100 Ah'] });
  assert.deepEqual(attrs('200W Flexible Solar Panel', 'solar_panels'), { power: ['200 W'], panelType: ['Flexible'] });
  assert.deepEqual(attrs('VE.Direct cable 50cm', 'Cables'), { cableType: ['VE.Direct'], length: ['0.5 m'] });
  assert.deepEqual(attrs('VE.Direct cable 0.5m', 'Cables').length, ['0.5 m']);
  assert.deepEqual(attrs('Battery monitor 12V 500A', 'Battery monitors'), {});
  assert.deepEqual(attrs('12-48 V battery', 'Batteries'), {});
  assert.deepEqual(attrs('Controller', 'Solar chargers', { technicalData: { 'Battery voltage': '12-48 V' } }), {});
  assert.deepEqual(attrs('100W Solar Panel', 'Solar panels').panelType, undefined);
  assert.deepEqual(attrs('12V battery', 'Batteries', { technicalData: { 'Battery voltage': '12-48 V' } }), {});
  assert.deepEqual(attrs('12V 100W Solar Kit', 'Solar panels'), {});
});

test('availability can match both warehouses; manual Hubble and local-only LoRa remain distinct', () => {
  const p = product('Product', 'Other', { localStockOnHand: 3 });
  p.stock_on_hand = 5;
  assert.deepEqual(productAvailability(p), ['thanda', 'supplier']);
  assert.deepEqual(productAvailability({ ...p, details: {}, stock_on_hand: 0 }), ['unavailable']);
  assert.deepEqual(productAvailability({ ...p, supplier: 'lora', details: {} }), ['unavailable']);
  assert.deepEqual(productAvailability({ ...p, supplier: 'hubble', stock_on_hand: 0, details: { manualAvailability: 'In stock (3-5 days)' } }), ['supplier']);
  assert.deepEqual(productAvailability({ ...p, stock_on_hand: 0, details: { localStockOnHand: -1 } }), ['unavailable']);
});

test('filters OR within a group and AND across groups; facet counts exclude their own selection', () => {
  const products = [
    { ...product('A', 'Inverters', { localStockOnHand: 1 }), catalogue_attributes: { batteryVoltage: ['48 V'], power: ['3000 VA'] } },
    { ...product('B', 'Inverters'), stock_on_hand: 2, catalogue_attributes: { batteryVoltage: ['24 V'], power: ['3000 VA'] } },
    { ...product('C', 'Inverters'), catalogue_attributes: { batteryVoltage: ['48 V'], power: ['5000 VA'] } },
  ];
  assert.equal(products.filter((p) => matchesCatalogueFilters(p, { batteryVoltage: ['24 V', '48 V'], power: ['3000 VA'] })).length, 2);
  assert.equal(products.filter((p) => matchesCatalogueFilters(p, { batteryVoltage: ['48 V'] }, ['supplier'])).length, 0);
  const facets = catalogueFacets(products, { batteryVoltage: ['48 V'], power: ['3000 VA'] });
  assert.deepEqual(facets.find((f) => f.key === 'batteryVoltage').options, [{ value: '24 V', count: 1 }, { value: '48 V', count: 1 }]);
  assert.equal(matchesCatalogueFilters({ catalogue_attributes: {} }, { batteryVoltage: ['48 V'] }), false);
});

test('lightweight supplier upsert retains cached specifications and persists attributes and provenance', async () => {
  const calls = [];
  const client = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: sql.startsWith('SELECT') ? [{ details: { technicalData: { 'Battery voltage': '12/24/48 V' }, localStockOnHand: 4 } }] : [] };
  } };
  await upsertProduct(client, { ...product('SmartSolar MPPT 100/50', 'Solar chargers'), sku: 'SCC-test' });
  const saved = JSON.parse(calls[1].params[8]);
  assert.deepEqual(saved.catalogueAttributes.batteryVoltage, ['12 V', '24 V', '48 V']);
  assert.equal(saved.catalogueAttributeSources.batteryVoltage, 'supplier specification: Battery voltage');
  assert.equal(saved.localStockOnHand, undefined, 'sync must not overwrite a concurrent Xero stock update');
});

test('discovery keeps successor and predecessor specifications and stock on their own saleable rows', () => {
  // Succession grouping is for fulfilment/planning. These literal catalogue
  // records must not borrow stock or product specifications from each other.
  const old = { ...product('MultiPlus-II 48/3000/35-32 230V', 'Inverters'), sku: 'PMP482305010' };
  const current = { ...old, sku: 'PMP482305012', stock_on_hand: 2 };
  assert.deepEqual(productAvailability(old), ['unavailable']);
  assert.deepEqual(productAvailability(current), ['supplier']);
  assert.deepEqual(deriveCatalogueAttributes(old).attributes, deriveCatalogueAttributes(current).attributes);
});
