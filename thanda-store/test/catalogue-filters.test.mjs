import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveCatalogueAttributes, catalogueFacets, matchesCatalogueFilters, productAvailability, cableMeasurement } from '../src/lib/catalogue-filters.mjs';
import { classifyCatalogueProduct, isStorefrontProduct } from '../src/lib/catalogue-classification.mjs';
import { upsertProduct } from '../scripts/product-sync-lib.mjs';

const product = (name, category, details = {}) => ({ name, category, supplier: 'victron', details, stock_on_hand: 0 });
const attrs = (name, category, details) => deriveCatalogueAttributes(product(name, category, details)).attributes;

test('reviewed Victron inverter names keep apparent power separate from watts', () => {
  assert.deepEqual(attrs('MultiPlus-II 48/3000/35-32 230V', 'Inverters and chargers'), {
    productType: ['Inverter / inverter-charger'], range: ['MultiPlus-II'], batteryVoltage: ['48 V'], power: ['3000 VA'], acVoltage: ['230 V'],
  });
  assert.deepEqual(attrs('Quattro 24/5000/120-100/100 120VAC', 'Inverters and chargers').acVoltage, ['120 V']);
  assert.deepEqual(attrs('Cover for MultiPlus-II 48/3000 230V', 'Inverters and chargers').power, undefined);
});

test('MPPT pair describes PV voltage and current, never assumed battery compatibility', () => {
  assert.deepEqual(attrs('SmartSolar MPPT 100/50', 'Solar chargers'), { productType: ['Solar charger'], maxPvVoltage: ['100 V'], chargeCurrent: ['50 A'] });
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
  assert.deepEqual(attrs('12.8V 100Ah Lithium Battery', 'Batteries'), { productType: ['Battery'], batteryVoltage: ['12.8 V'], capacity: ['100 Ah'] });
  assert.deepEqual(attrs('200W Flexible Solar Panel', 'solar_panels'), { productType: ['Solar panel'], power: ['200 W'], panelType: ['Flexible'] });
  assert.deepEqual(attrs('VE.Direct cable 50cm', 'Cables'), { productType: ['Cable'], cableType: ['VE.Direct'], cableLength: ['0.5 m'] });
  assert.deepEqual(attrs('VE.Direct cable 0.5m', 'Cables').cableLength, ['0.5 m']);
  assert.deepEqual(attrs('Battery monitor 12V 500A', 'Battery monitors'), {});
  assert.deepEqual(attrs('12-48 V battery', 'Batteries').batteryVoltage, undefined);
  assert.deepEqual(attrs('Controller', 'Solar chargers', { technicalData: { 'Battery voltage': '12-48 V' } }).batteryVoltage, undefined);
  assert.deepEqual(attrs('100W Solar Panel', 'Solar panels').panelType, undefined);
  assert.deepEqual(attrs('12V battery', 'Batteries', { technicalData: { 'Battery voltage': '12-48 V' } }).batteryVoltage, undefined);
  assert.deepEqual(attrs('12V 100W Solar Kit', 'Solar panels').power, undefined);
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


test('mixed supplier categories classify the actual item while retaining equipment groups', () => {
  const classify = (name, category, subcategory) => classifyCatalogueProduct(product(name, category, { subcategory }));
  assert.equal(classify('130W-12V Mono 1200x668x30mm', 'Solar panels and cables', 'Solar panels monocrystalline').category, 'Solar panels');
  assert.equal(classify('Solarcable L=3m/4sqmm', 'Solar panels and cables', 'Cables, connectors and accessories for solar panels').kind, 'cable');
  assert.equal(classify('VE.Direct Cable 0,3m', 'Miscellaneous', 'Cables').category, 'Cables & connectors');
  assert.equal(classify('USB extension cable 0,3m', 'Remote panels & monitoring').kind, 'cable');
  assert.equal(classify('Battery Monitor BMV-700', 'Battery monitors and SmartShunt', 'Battery Monitors & Accessories').category, 'Battery monitors and SmartShunt');
  assert.equal(classify('Blue Smart IP65 Charger 12/15 with plug', 'Blue Power Chargers', 'Blue Smart IP65 Chargers').category, 'Blue Power Chargers');
  assert.equal(classify('DIN35 adapter small (2 pcs)', 'Remote panels & monitoring', 'GX Products').category, 'Other accessories');
  assert.equal(classify('GX Touch 50 adapter for CCGX cut-out', 'Remote panels & monitoring').kind, 'accessory');
  assert.equal(classify('Outdoor LTE-M antenna (with 3m cable)', 'Remote panels & monitoring').kind, 'accessory');
  assert.equal(classify('Renogy Solar Panel Cable Connectors', 'solar_panel').kind, 'connector');
  assert.equal(classify('Renogy Adjustable Solar Panel Roof Tilt Mount', 'solar_panel').kind, 'accessory');
  assert.equal(classify('CORE Solar Panel to Charge Controller Adaptor Kit 20 Ft', 'solar_panel').kind, 'adapter');
  assert.equal(classify('TMB Series', 'solar_panel').kind, 'other');
  assert.ok(classify('TMB Series', 'solar_panel').reviewReason);
});

test('numeric measurements normalize decimal commas and units without borrowing dimensions or ratings', () => {
  for (const value of ['0,3m', '0.3 m', '30cm', '300 mm']) assert.equal(cableMeasurement(value, 'length'), 0.3);
  assert.equal(cableMeasurement('1,8 m', 'length'), 1.8);
  assert.equal(cableMeasurement('RJ45-splitter 1xRJ45 male/15cm cable/2xRJ45 female', 'length'), 0.15);
  assert.equal(cableMeasurement('2 meter extension cable 25A', 'length'), 2);
  for (const value of ['0.3-1.8 m', '1/2 m', '100x200x30mm', '1 m or 2 m', '4mm²', '10AWG']) assert.equal(cableMeasurement(value, 'length'), null, value);
  const shore = deriveCatalogueAttributes(product('Shore Power Cord 15m 16A/250Vac (3x2,5sqmm)', 'Miscellaneous', { subcategory: 'Shore cables, inlets and accessories' }));
  assert.deepEqual(shore.measurements, { cableLengthM: 15, conductorSizeMm2: 2.5 });
  assert.equal(shore.attributes.acVoltage, undefined);
  assert.deepEqual(shore.attributes.cableType, ['Shore power']);
  const panel = deriveCatalogueAttributes(product('130W-12V Mono 1200x668x30mm', 'Solar panels and cables', { subcategory: 'Solar panels monocrystalline' }));
  assert.deepEqual(panel.attributes.power, ['130 W']);
  assert.deepEqual(panel.measurements, {});
  assert.equal(panel.attributes.cableLength, undefined);
  assert.deepEqual(attrs('100 Watt Flexible Solar Panel', 'solar_panel').power, ['100 W']);
  assert.deepEqual(attrs('12,8V/100Ah battery', 'Batteries').capacity, ['100 Ah']);
  const bms = attrs('VE.Bus BMS 12/200', 'Batteries', { subcategory: 'Battery Management Systems (BMS)' });
  assert.equal(bms.batteryVoltage, undefined);
  const antenna = deriveCatalogueAttributes(product('Outdoor LTE-M antenna (with 3m cable)', 'Remote panels & monitoring'));
  assert.deepEqual(antenna.measurements, {});
});

test('connection families distinguish BMS types and normalize lengths in numeric order', () => {
  for (const letter of ['A', 'B']) assert.deepEqual(attrs(`VECan-CANbus BMS type${letter} Cable 1,8 m`, 'Miscellaneous', { subcategory: 'Cables' }).cableType, [`VE.Can–BMS type ${letter}`]);
  for (const family of ['VE.Direct', 'RJ12', 'RJ45']) assert.deepEqual(attrs(`${family} cable 0,3m`, 'Miscellaneous', { subcategory: 'Cables' }).cableType, [family]);
  const options = catalogueFacets([0.9, 0.15, 10, 1.8].map(n => ({ catalogue_attributes: { cableLength: [`${n} m`] } }))).find(f => f.key === 'cableLength');
  assert.equal(options.label, 'Cable length');
  assert.deepEqual(options.options.map(o => o.value), ['0.15 m', '0.9 m', '1.8 m', '10 m']);
});

test('explicit specifications and reviewed overrides take precedence; sync retains reviewed exceptions', async () => {
  const details = { subcategory: 'Cables', technicalData: { 'Cable length': '30cm', 'Conductor cross-section': '2,5 mm²' }, catalogueOverride: { kind: 'cable', cableLengthM: 0.4, conductorSizeMm2: null, reason: 'Checked product packaging' } };
  const p = product('Unclear product 2m', 'Miscellaneous', details);
  const derived = deriveCatalogueAttributes(p);
  assert.deepEqual(derived.measurements, { cableLengthM: 0.4 });
  assert.equal(derived.sources.cableLength, 'reviewed override: Checked product packaging');
  assert.equal(deriveCatalogueAttributes({ ...p, details: { ...details, catalogueOverride: { kind: 'cable' } } }).classification.kind, 'other');
  const calls = [];
  const client = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: sql.startsWith('SELECT') ? [{ details }] : [] }; } };
  await upsertProduct(client, { ...p, sku: 'REVIEWED', details: { subcategory: 'Cables' } });
  const saved = JSON.parse(calls[1].params[8]);
  assert.deepEqual(saved.catalogueMeasurements, { cableLengthM: 0.4 });
  assert.equal(saved.catalogueClassification.kind, 'cable');
  assert.equal(saved.catalogueOverride, undefined, 'sync leaves the existing override key untouched in the JSONB merge');
  assert.match(calls[1].sql, /details = products.details \|\| EXCLUDED.details/);
  const explicit = deriveCatalogueAttributes(product('VE.Direct Cable 2m', 'Miscellaneous', { subcategory: 'Cables', technicalData: { 'Cable length': '30cm' } }));
  assert.equal(explicit.measurements.cableLengthM, 0.3);
  assert.match(explicit.sources.cableLength, /^supplier specification/);
  assert.deepEqual(deriveCatalogueAttributes(product('VE.Direct Cable 2m', 'Miscellaneous', { subcategory: 'Cables', technicalData: { 'Cable length': '1-2 m' } })).measurements, {});
});

test('display categories preserve original supplier category and Renogy storefront eligibility', () => {
  const p = { ...product('Renogy Solar Panel Cable Connectors', 'solar_panel'), supplier: 'renogy' };
  const derived = deriveCatalogueAttributes(p);
  assert.equal(p.category, 'solar_panel');
  assert.equal(isStorefrontProduct({ ...p, category: derived.classification.category, supplier_category: p.category }), true);
  assert.equal(isStorefrontProduct({ ...p, category: 'Cables & connectors', supplier_category: 'accessories' }), false);
});
