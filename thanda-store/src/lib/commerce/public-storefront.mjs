import { isCatalogueRestricted } from '../catalogue-access.mjs';
import { isStorefrontProduct } from '../catalogue-classification.mjs';
import { localStockObservation } from '../data-freshness.mjs';
import { normalizeSku, skuFamilyResolver, successorSkus } from '../sku-successions.mjs';

const supplierName = value => String(value || '').trim().toLowerCase();
const hidden = row => row.details?.hidden === true || row.details?.hidden === 'true';
const safePart = value => /^[A-Za-z0-9._-]+$/.test(String(value || ''));
/** @type {(row: { supplier: string, sku: string }) => boolean} */
const noThumbnail = () => false;

function imageUrl(row, hasThumbnail) {
  if (safePart(row.supplier) && safePart(row.sku) && hasThumbnail(row)) {
    return `/api/product-images/${encodeURIComponent(row.supplier)}/${encodeURIComponent(row.sku)}`;
  }
  try {
    const url = new URL(row.image_url);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search
      && ['victronenergy.com', 'www.victronenergy.com'].includes(url.hostname)) return url.href;
  } catch { /* A missing/unreviewed image is a useful empty state. */ }
  return null;
}

/** Deliberately independent of the cost-bearing authenticated catalogue object. */
export function selectPublicProducts(rows, successions, config, { now = Date.now(), hasThumbnail = noThumbnail } = {}) {
  const familyFor = skuFamilyResolver(successions);
  const visible = rows.filter(row => !hidden(row) && !isCatalogueRestricted(row) && isStorefrontProduct(row));
  const result = [];
  const emitted = new Set();
  for (const selected of [...config].sort((a, b) => Number(a.position || 0) - Number(b.position || 0)).slice(0, 8)) {
    // Publishing a brand alone never publishes its catalogue: this exact
    // reviewed selection (and its explicit canonical replacements) is required.
    const supplier = supplierName(selected.supplier);
    if (!['victron', 'lora'].includes(supplier) || !safePart(selected.sku)) continue;
    const family = familyFor(supplier, selected.sku);
    if (emitted.has(family)) continue;
    const members = visible.filter(row => supplierName(row.supplier) === supplier && familyFor(supplier, row.sku) === family);
    const preferred = [...successorSkus(successions, supplier, selected.sku), selected.sku].map(sku => normalizeSku(supplier, sku));
    const row = preferred.map(sku => members.filter(item => normalizeSku(supplier, item.sku) === sku)
      .sort((a, b) => Number(String(a.sku).endsWith('R')) - Number(String(b.sku).endsWith('R')))[0]).find(Boolean);
    if (!row || !Number.isSafeInteger(Number(row.id)) || Number(row.id) < 1) continue;
    const observation = localStockObservation(row);
    const observedMs = Date.parse(observation.observedAt || '');
    const current = observation.quantity !== null && Number.isFinite(observedMs)
      && observedMs <= now + 300_000 && now - observedMs <= 120 * 60_000;
    // Construct every key. Never spread rows, details, history or prices.
    result.push({
      id: Number(row.id), supplier, sku: String(row.sku), name: String(row.name), category: String(row.category || ''),
      summary: String(selected.summary || '').slice(0, 300), imageUrl: imageUrl(row, hasThumbnail),
      requestQuoteUrl: `https://store.thanda.solar/request-quote?product=${Number(row.id)}`,
      availability: { local: !current ? 'unknown' : observation.quantity > 0 ? 'in_stock' : 'out_of_stock', observedAt: observation.observedAt },
    });
    emitted.add(family);
  }
  return result;
}
