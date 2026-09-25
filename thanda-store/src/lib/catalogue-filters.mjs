// Shared by supplier syncs, local backfill, catalogue presentation and the browser.
export const filterDefinitions = [
  { key: 'range', label: 'Range' },
  { key: 'batteryVoltage', label: 'Battery voltage' },
  { key: 'acVoltage', label: 'AC voltage' },
  { key: 'power', label: 'Power' },
  { key: 'chargeCurrent', label: 'Charge current' },
  { key: 'maxPvVoltage', label: 'Maximum PV voltage' },
  { key: 'cableType', label: 'Cable type' },
  { key: 'length', label: 'Length' },
  { key: 'capacity', label: 'Capacity' },
  { key: 'panelType', label: 'Panel type' },
];

export const availabilityOptions = [
  { key: 'thanda', label: 'Thanda stock' },
  { key: 'supplier', label: 'Supplier stock' },
  { key: 'unavailable', label: 'Unavailable' },
];

function productKind(category) {
  const text = String(category || '').replace(/_/g, ' ').toLowerCase();
  if (/cable/.test(text)) return 'cable';
  if (/solar.*(charger|controller)|charge controller|mppt/.test(text)) return 'charger';
  if (/inverter|multi(?:plus)?|quattro/.test(text)) return 'inverter';
  if (/^(?:lithium |smart |deep cycle |agm |gel )?batter(?:y|ies)$/.test(text)) return 'battery';
  if (/solar (panel|module)/.test(text)) return 'panel';
  return '';
}

const keysByKind = {
  inverter: ['range', 'batteryVoltage', 'acVoltage', 'power', 'maxPvVoltage'],
  charger: ['batteryVoltage', 'chargeCurrent', 'maxPvVoltage'],
  cable: ['cableType', 'length'],
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
  'cable length': 'length',
  'battery capacity': 'capacity',
  'nominal capacity': 'capacity',
};

function quantities(text, units) {
  // Require the whole value: never extract 12 V from a 12-48 V range.
  const match = String(text).trim().match(new RegExp(`^(\\d+(?:\\.\\d+)?(?:\\s*[/,]\\s*\\d+(?:\\.\\d+)?)*)\\s*(${units})$`, 'i'));
  if (!match) return [];
  return match[1].split(/[/,]/).map(Number).filter((n) => n > 0).map((n) => {
    const unit = match[2].toLowerCase().replace('vac', 'v');
    const multiplier = ['kw', 'kva', 'kwh'].includes(unit) ? 1000 : unit === 'cm' ? 0.01 : 1;
    const normalizedUnit = { v: 'V', a: 'A', w: 'W', kw: 'W', va: 'VA', kva: 'VA', ah: 'Ah', wh: 'Wh', kwh: 'Wh', m: 'm', cm: 'm' }[unit];
    return `${Number((n * multiplier).toFixed(4))} ${normalizedUnit}`;
  });
}

export function deriveCatalogueAttributes(product) {
  const kind = productKind(product.category);
  const allowed = keysByKind[kind] || [];
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
  const unitValues = (units) => [...name.matchAll(new RegExp(`(?<![\\w.\\-/])([0-9]+(?:\\.[0-9]+)?(?:\\s*[/,]\\s*[0-9]+(?:\\.[0-9]+)?)*)\\s*(${units})\\b`, 'gi'))]
    .flatMap((m) => quantities(`${m[1]} ${m[2]}`, units));

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
  if (kind === 'cable') {
    put('length', unitValues('cm|m'));
    const type = name.match(/\b(VE\.Direct|VE\.Can|VE\.Bus|RJ45|MC4|USB|HDMI)\b/i)?.[1];
    if (type) put('cableType', [({ 've.direct': 'VE.Direct', 've.can': 'VE.Can', 've.bus': 'VE.Bus' })[type.toLowerCase()] || type.toUpperCase()]);
  }

  const technical = product.details?.technicalData;
  const specs = Array.isArray(technical) ? technical.map((entry) => [entry?.name ?? entry?.label, entry?.value])
    : technical && typeof technical === 'object' ? Object.entries(technical) : [];
  const units = { batteryVoltage: 'V', acVoltage: 'V', power: 'kVA|VA|kW|W', chargeCurrent: 'A', maxPvVoltage: 'V', length: 'cm|m', capacity: 'Ah|kWh|Wh' };
  for (const [label, value] of specs) {
    const key = specificationLabels[String(label).trim().toLowerCase()];
    if (key && allowed.includes(key)) {
      // A supplied but unparseable value must not fall back to a conflicting
      // name-derived rating (for example a voltage range or 'see manual').
      delete attributes[key];
      delete sources[key];
      put(key, quantities(value, units[key]), `supplier specification: ${label}`);
    }
  }
  return { attributes, sources };
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
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((value) => ({
        value,
        count: products.filter((product) => matchesCatalogueFilters(product, { ...selected, [definition.key]: [value] }, availability)).length,
      }));
    return options.length ? [{ ...definition, options }] : [];
  });
}
