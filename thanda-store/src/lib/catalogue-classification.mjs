// Customer-facing classification only. Never rewrite supplier categories or SKUs.
const connectionKinds = new Set(['cable', 'adapter', 'connector']);
const typeLabels = { cable: 'Cable', adapter: 'Adapter', connector: 'Connector', panel: 'Solar panel', battery: 'Battery', inverter: 'Inverter / inverter-charger', charger: 'Solar charger', accessory: 'Other accessory', other: 'Other' };

export function reviewedCatalogueOverride(product) {
  const override = product.details?.catalogueOverride;
  return override && typeof override === 'object' && typeof override.reason === 'string' && override.reason.trim()
    ? override : {};
}

export function classifyCatalogueProduct(product) {
  const category = String(product.supplier_category ?? product.category ?? 'uncategorized');
  const subcategory = String(product.details?.subcategory || '').trim();
  const name = String(product.name || '').trim();
  const broad = category.replace(/_/g, ' ').toLowerCase();
  const specific = subcategory.toLowerCase();
  const context = `${category} ${subcategory}`;
  const result = (kind, source, typeLabel = typeLabels[kind], reviewReason = null) => ({
    kind,
    category: connectionKinds.has(kind) ? 'Cables & connectors' : kind === 'panel' ? 'Solar panels' : kind === 'accessory' ? 'Other accessories' : category,
    typeLabel, source, reviewReason,
  });
  const override = reviewedCatalogueOverride(product);
  if (override.kind && Object.hasOwn(typeLabels, override.kind)) return result(override.kind, `reviewed override: ${override.reason}`);

  if (/solar.?panel|cables?/i.test(context) && /\badapt[eo]r kit\b/i.test(name)) return result('adapter', 'product name');

  // Even subcategories can mix equipment and accessories. Recognize the sold
  // item before interpreting incidental plugs, leads or host-device ratings.
  const accessoryTypes = [
    [/\bkit\b/i, 'Kit'],
    [/wirebox/i, 'Wirebox'],
    [/^(?:.*\b(?:DIN35|cut-out)\b.*adapter|.*adapter.*\bcut-out\b)|\b(?:wall.?mount|mount|mounting|bracket|rubber bumper)\b|^(?:mount|mounting|bracket|holder|cover|case)\b/i, 'Mounting / protection'],
    [/\b(?:sensor|probe)\b/i, 'Sensor'],
    [/\b(?:dongle|antenna|wifi module)\b/i, 'Communication accessory'],
    [/\bservice tool\b/i, 'Service tool'],
    [/\b(?:fuse holder|battery indicator)\b/i, 'Other accessory'],
  ];
  for (const [pattern, label] of accessoryTypes) {
    if (pattern.test(name)) return result('accessory', 'product name', label);
  }

  // Explicit panel subcategories outrank incidental mentions of their leads.
  const panelName = /\bsolar panel\b/i.test(name);
  const panelContext = /^solar panels?(?: (?:monocrystalline|polycrystalline))?$/.test(specific);
  const panelPart = /\b(?:connectors?|adapt[eo]rs?|extension|cables?|brackets?|mount|mounting)\b/i.test(name);
  if ((panelContext || panelName) && !panelPart) {
    return result('panel', panelContext ? `supplier subcategory: ${subcategory}` : 'product name');
  }

  const namedCable = /\b(?:cables?|adaptercable|solarcable|cords?|leads?)\b/i.test(name);
  const includedCable = /\b(?:with|includes?|incl\.)\b.*\b(?:cable|cord|lead)\b/i.test(name)
    && /\b(?:panel|charger|inverter|monitor)\b/i.test(name);
  const cablePart = /\bcable (?:gland|clamp|lug|entry)\b/i.test(name);
  if (namedCable && !includedCable && !cablePart && !/\bcable connectors?\b/i.test(name)) {
    return result(/adapter|splitter|interface/i.test(name) ? 'adapter' : 'cable', `product name within ${subcategory || category}`);
  }
  const connectionContext = /cable|connector|shore|accessor|monitor|miscellaneous|solar.?panel/i.test(context);
  if (connectionContext && (/adapter|interface|splitter/i.test(name) || /^RS232 to USB converter\b/i.test(name))) {
    return result('adapter', `product name within ${subcategory || category}`);
  }
  if (connectionContext && /\b(?:connectors?|coupling|inlet|terminator|plug)\b/i.test(name)
    && !/\b(?:charger|inverter|converter|powerbank|power bank)\b/i.test(name)) return result('connector', `product name within ${subcategory || category}`);

  // Specific BMS grouping prevents battery ratings being assigned to BMS
  // equipment. Mixed "Monitors & Accessories" groups likewise stay intact.
  if (/battery management systems/i.test(subcategory)) return result('other', `supplier subcategory: ${subcategory}`, 'Battery management');
  if (/\b(?:inverter|multi(?:plus)?|quattro)/i.test(specific || broad)) return result('inverter', `supplier ${subcategory ? 'subcategory' : 'category'}: ${subcategory || category}`);
  if (/solar.*(?:charger|controller)|charge controller|mppt/i.test(specific || broad)) return result('charger', `supplier ${subcategory ? 'subcategory' : 'category'}: ${subcategory || category}`);
  if (/^(?:lithium |smart |deep cycle |agm |gel )?batter(?:y|ies)$/.test(broad)) return result('battery', `supplier category: ${category}`);
  if (/^accessor/i.test(broad) || /^accessor/i.test(specific) || cablePart) return result('accessory', `supplier grouping: ${subcategory || category}`);
  const uncertain = /miscellaneous|uncategorized|solar panel|^cables$/i.test(broad) || /^cables$/i.test(specific);
  return result('other', `supplier category retained: ${category}`, 'Other', uncertain ? 'No reliable specific product type; category retained and specifications left unset.' : null);
}

export function isStorefrontProduct(product) {
  // Catalogue cleanup must not expand the separately agreed Renogy range.
  const originalCategory = product.supplier_category ?? product.category;
  return product.supplier?.toLowerCase() !== 'renogy'
    || ['battery', 'batteries', 'solar panel', 'solar panels', 'solar_panel', 'solar_panels'].includes(String(originalCategory).trim().toLowerCase());
}
