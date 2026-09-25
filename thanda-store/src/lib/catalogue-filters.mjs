import { classifyCatalogueProduct, reviewedCatalogueOverride } from './catalogue-classification.mjs';

// Shared by supplier syncs, local backfill, catalogue presentation and the browser.
export const filterDefinitions = [
  { key: 'productType', label: 'Product type' },
  { key: 'range', label: 'Range' },
  { key: 'batteryVoltage', label: 'Battery voltage' },
  { key: 'acVoltage', label: 'AC voltage' },
  { key: 'power', label: 'Power' },
  { key: 'chargeCurrent', label: 'Charge current' },
  { key: 'maxPvVoltage', label: 'Maximum PV voltage' },
  { key: 'cableType', label: 'Cable family' },
  { key: 'cableLength', label: 'Cable length' },
  { key: 'conductorSize', label: 'Conductor size' },
  { key: 'capacity', label: 'Capacity' },
  { key: 'panelType', label: 'Panel type' },
];

export const availabilityOptions = [
  { key: 'thanda', label: 'Thanda stock' },
  { key: 'supplier', label: 'Supplier stock' },
  { key: 'unavailable', label: 'Unavailable' },
];

const keysByKind = {
  inverter: ['range', 'batteryVoltage', 'acVoltage', 'power', 'maxPvVoltage'],
  charger: ['batteryVoltage', 'chargeCurrent', 'maxPvVoltage'],
  cable: ['cableType', 'cableLength', 'conductorSize'],
  adapter: ['cableType', 'cableLength', 'conductorSize'],
  connector: ['cableType', 'conductorSize'],
  battery: ['batteryVoltage', 'capacity'],
  panel: ['power', 'panelType'],
};

// Exact, unit-bearing specifications take precedence over name parsing. Unknown
// supplier shapes/labels and ambiguous ranges are deliberately not interpreted.
const specificationLabels = {
  'battery voltage': 'batteryVoltage',
  'nominal battery voltage': 'batteryVoltage',
  'ac output voltage': 'acVoltage',
  'rated power': 'power',
  'nominal power': 'power',
  'rated charge current': 'chargeCurrent',
  'maximum charge current': 'chargeCurrent',
  'max pv voltage': 'maxPvVoltage',
  'maximum pv voltage': 'maxPvVoltage',
  'maximum dc pv voltage': 'maxPvVoltage',
  'maximum pv open circuit voltage': 'maxPvVoltage',
  'cable length': 'cableLength',
  'conductor cross-section': 'conductorSize',
  'conductor size': 'conductorSize',
  'battery capacity': 'capacity',
  'nominal capacity': 'capacity',
};

function quantities(text, units) {
  // Require the whole value: never extract 12 V from a 12-48 V range.
  const match = String(text).replace(/(\d),(?=\d)/g, '$1.').trim().match(new RegExp(`^(\\d+(?:\\.\\d+)?(?:\\s*[/,]\\s*\\d+(?:\\.\\d+)?)*)\\s*(${units})$`, 'i'));
  if (!match) return [];
  return match[1].split(/[/,]/).map(Number).filter((n) => n > 0).map((n) => {
    const unit = match[2].toLowerCase().replace('vac', 'v');
    const multiplier = ['kw', 'kva', 'kwh'].includes(unit) ? 1000 : unit === 'cm' ? 0.01 : 1;
    const normalizedUnit = { v: 'V', a: 'A', w: 'W', kw: 'W', va: 'VA', kva: 'VA', ah: 'Ah', wh: 'Wh', kwh: 'Wh', m: 'm', cm: 'm' }[unit];
    return `${Number((n * multiplier).toFixed(4))} ${normalizedUnit}`;
  });
}

// Scalar cable measurements, kept numeric in SI units. Multiple differing
// lengths, ranges and dimensions are ambiguous and deliberately remain unset.
export function cableMeasurement(value, kind, exact = false) {
  const text = String(value ?? '').replace(/(\d),(?=\d)/g, '$1.');
  const number = '(\\d+(?:\\.\\d+)?)';
  const units = kind === 'length' ? '(mm|cm|m|metres?|meters?|mtr)' : '(mm²|mm2|sqmm)';
  const end = kind === 'length' ? '(?![\\w²])' : '(?![\\w])';
  const expression = exact ? new RegExp(`^\\s*${number}\\s*${units}\\s*$`, 'i')
    : new RegExp(`(?<![\\w.,–-])${number}\\s*${units}${end}`, 'gi');
  // Do not reinterpret the tail of 0.3-1.8 m, 1/2 m or panel dimensions.
  if (kind === 'length' && /\d\s*[-–/x×]\s*\d+(?:\.\d+)?\s*(?:mm|cm|m)\b/i.test(text)) return null;
  const matches = exact ? [text.match(expression)].filter(Boolean) : [...text.matchAll(expression)];
  // A 3x2.5sqmm cable records 2.5 mm² conductor area, not three lengths.
  const areaMatches = kind === 'area' && !exact ? [...text.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*(mm²|mm2|sqmm)(?!\w)/gi)] : matches;
  const values = [...new Set(areaMatches.map(m => Number((Number(m[1]) * (kind === 'length' ? ({ mm: 0.001, cm: 0.01 }[m[2].toLowerCase()] || 1) : 1)).toFixed(6))).filter(n => n > 0))];
  return values.length === 1 ? values[0] : null;
}

export function deriveCatalogueAttributes(product) {
  const classification = classifyCatalogueProduct(product);
  const { kind } = classification;
  const allowed = ['productType', ...(keysByKind[kind] || [])];
  /** @type {Record<string, number>} */
  const measurements = {};
  /** @type {Record<string, string[]>} */
  const attributes = {};
  const sources = {};
  const name = String(product.name || '');
  const put = (key, values, source = 'product name') => {
    if (allowed.includes(key) && values.length) {
      attributes[key] = [...new Set(values)];
      sources[key] = source;
    }
  };
  const unitName = name.replace(/(\d),(?=\d)/g, '$1.').replace(/\bwatts?\b/gi, 'W').replace(/([a-z])\/(?=\d)/gi, '$1 ');
  const unitValues = (units) => [...unitName.matchAll(new RegExp(`(?<![\\w.\\-/])([0-9]+(?:\\.[0-9]+)?(?:\\s*[/,]\\s*[0-9]+(?:\\.[0-9]+)?)*)\\s*(${units})\\b`, 'gi'))]
    .flatMap((m) => quantities(`${m[1]} ${m[2]}`, units));

  if (kind !== 'other' || classification.typeLabel !== 'Other') put('productType', [classification.typeLabel], classification.source);

  // Avoid attributing the specifications of a host device to its accessories.
  const accessory = /\b(kit|cover|case|replacement|spare|bracket|remote|display|dongle)\b/i.test(name);
  if (!accessory) {
    if (kind === 'inverter') {
      const range = name.match(/\b(MultiPlus-II|MultiPlus|Quattro-II|Quattro|(?:Inverter|Multi) RS|Phoenix)\b/i)?.[1];
      const canonical = { 'multiplus-ii': 'MultiPlus-II', multiplus: 'MultiPlus', 'quattro-ii': 'Quattro-II', quattro: 'Quattro', 'inverter rs': 'RS', 'multi rs': 'RS', phoenix: 'Phoenix' };
      if (range) put('range', [canonical[range.toLowerCase()]]);
      // Victron model numbers express battery volts / apparent power (VA).
      // See README: catalogue attribute parsing references.
      const model = product.supplier === 'victron' && name.match(/\b(?:MultiPlus(?:-II)?|Quattro(?:-II)?|Phoenix|Inverter)(?:\s+(?:Compact|Smart|GX))?\s+(12|24|48)\/(\d{3,5})(?:\/|\b)/i);
      if (model) {
        put('batteryVoltage', [`${model[1]} V`]);
        put('power', [`${model[2]} VA`]);
      }
      // These reviewed 48/6000 solar models have a 450 V maximum PV input.
      // The plain Inverter RS Smart has no solar input and must not match.
      // References and the actual supplier naming variants are in README/tests.
      if (product.supplier === 'victron') {
        const multiRsSolar = /^Multi RS Solar\s+48\/6000\b/i.test(name);
        const inverterRsSolar = /^Inverter RS\s+(?:(?:Smart\s+)?Solar\s+48\/6000\b|48\/6000\s+230V\s+Smart Solar\b)/i.test(name);
        if (multiRsSolar || inverterRsSolar) {
          const manual = multiRsSolar ? 'Multi_RS_Solar' : 'Inverter_RS_Smart_Solar';
          put('maxPvVoltage', ['450 V'], `manufacturer specification: https://www.victronenergy.com/media/pg/${manual}/en/technical-specifications.html`);
        }
      }
      const volts = unitValues('VAC|V');
      put('acVoltage', volts.filter((v) => /^(120|230|240) V$/.test(v)));
      if (!model) {
        put('batteryVoltage', volts.filter((v) => /^(12|24|48) V$/.test(v)));
        put('power', unitValues('kVA|VA|kW|W'));
      }
    }
    if (kind === 'charger') {
      // MPPT PV voltage/current are explicit in these model names. Battery
      // compatibility cannot be inferred from that pair and remains unset.
      const model = product.supplier === 'victron' && name.match(/\b(?:SmartSolar\s+MPPT(?:\s+RS)?|BlueSolar\s+MPPT)\s+(\d{2,3})\/(\d{1,3})\b/i);
      if (model) {
        put('maxPvVoltage', [`${model[1]} V`]);
        put('chargeCurrent', [`${model[2]} A`]);
      }
      const battery = name.match(/\b(?:battery(?: voltage)?[: ]+)([\d./, ]+V)\b/i);
      if (battery) put('batteryVoltage', quantities(battery[1], 'V'));
    }
    if (kind === 'battery') {
      put('batteryVoltage', unitValues('V'));
      put('capacity', unitValues('Ah|kWh|Wh'));
    }
    if (kind === 'panel') {
      put('power', unitValues('kW|W'));
      const type = name.match(/\b(rigid|flexible)\b/i)?.[1];
      if (type) put('panelType', [type.toLowerCase() === 'rigid' ? 'Rigid' : 'Flexible']);
    }
  }
  const setMeasurement = (key, value, source) => {
    if (!allowed.includes(key)) return;
    const field = key === 'cableLength' ? 'cableLengthM' : 'conductorSizeMm2';
    delete measurements[field];
    delete attributes[key];
    delete sources[key];
    if (value !== null) {
      measurements[field] = value;
      put(key, [`${value} ${key === 'cableLength' ? 'm' : 'mm²'}`], source);
    }
  };
  if (['cable', 'adapter', 'connector'].includes(kind)) {
    const familyText = `${name} ${product.details?.subcategory || ''}`;
    const bms = name.match(/VE[.\s-]?Can.*BMS\s*type\s*([AB])\b/i);
    const protocol = name.match(/\b(VE\.Direct|VE\.Can|VE\.Bus|RJ12|RJ45|USB|HDMI)\b/i)?.[1];
    const family = bms ? `VE.Can–BMS type ${bms[1].toUpperCase()}`
      : /shore/i.test(familyText) ? 'Shore power'
      : /solar|\bMC[34]\b/i.test(familyText) ? 'Solar'
      : /mains cord/i.test(name) ? 'Mains power'
      : protocol ? ({ 've.direct': 'VE.Direct', 've.can': 'VE.Can', 've.bus': 'VE.Bus' })[protocol.toLowerCase()] || protocol.toUpperCase()
      : /chargers?/i.test(product.details?.subcategory || '') ? 'Charger lead' : null;
    if (family) put('cableType', [family]);
    setMeasurement('cableLength', cableMeasurement(name, 'length'), 'product name');
    setMeasurement('conductorSize', cableMeasurement(name, 'area'), 'product name');
  }

  const technical = product.details?.technicalData;
  const specs = Array.isArray(technical) ? technical.map((entry) => [entry?.name ?? entry?.label, entry?.value])
    : technical && typeof technical === 'object' ? Object.entries(technical) : [];
  const units = { batteryVoltage: 'V', acVoltage: 'V', power: 'kVA|VA|kW|W', chargeCurrent: 'A', maxPvVoltage: 'V', capacity: 'Ah|kWh|Wh' };
  for (const [label, value] of specs) {
    const key = specificationLabels[String(label).trim().toLowerCase()];
    if (key && allowed.includes(key)) {
      if (key === 'cableLength' || key === 'conductorSize') {
        setMeasurement(key, cableMeasurement(value, key === 'cableLength' ? 'length' : 'area', true), `supplier specification: ${label}`);
        continue;
      }
      // A supplied but unparseable value must not fall back to a conflicting
      // name-derived rating (for example a voltage range or 'see manual').
      delete attributes[key];
      delete sources[key];
      put(key, quantities(value, units[key]), `supplier specification: ${label}`);
    }
  }
  const override = reviewedCatalogueOverride(product);
  for (const [field, key] of [['cableLengthM', 'cableLength'], ['conductorSizeMm2', 'conductorSize']]) {
    if (Object.hasOwn(override, field) && (override[field] === null || (typeof override[field] === 'number' && Number.isFinite(override[field]) && override[field] > 0))) {
      setMeasurement(key, override[field], `reviewed override: ${override.reason}`);
    }
  }
  return { attributes, sources, classification, measurements };
}

export function productAvailability(product) {
  const result = [];
  const local = Number(product.details?.localStockOnHand);
  const stock = Number(product.stock_on_hand);
  if (local > 0) result.push('thanda');
  // Hubble currently has an explicit manually maintained availability statement.
  const manual = String(product.details?.manualAvailability || '');
  if ((product.supplier !== 'lora' && stock > 0) || /^in stock\b/i.test(manual)) result.push('supplier');
  if (!result.length) result.push('unavailable');
  return result;
}

export function matchesCatalogueFilters(product, selected = {}, availability = []) {
  if (availability.length && !productAvailability(product).some((key) => availability.includes(key))) return false;
  return Object.entries(selected).every(([key, values]) => !values.length || values.some((value) => (product.catalogue_attributes?.[key] || []).includes(value)));
}

export function catalogueFacets(products, selected = {}, availability = []) {
  return filterDefinitions.flatMap((definition) => {
    const options = [...new Set(products.flatMap((product) => product.catalogue_attributes?.[definition.key] || []))]
      .sort((a, b) => ['cableLength', 'conductorSize'].includes(definition.key)
        ? parseFloat(a) - parseFloat(b) : a.localeCompare(b, undefined, { numeric: true }))
      .map((value) => ({
        value,
        count: products.filter((product) => matchesCatalogueFilters(product, { ...selected, [definition.key]: [value] }, availability)).length,
      }));
    return options.length ? [{ ...definition, options }] : [];
  });
}

export function catalogueDerivedDetails(product) {
  const { attributes, sources, classification, measurements } = deriveCatalogueAttributes(product);
  return { catalogueAttributes: attributes, catalogueAttributeSources: sources, catalogueClassification: classification, catalogueMeasurements: measurements };
}
