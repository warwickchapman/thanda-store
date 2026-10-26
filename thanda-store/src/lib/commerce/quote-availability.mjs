import { DATA_SOURCES, localStockObservation, observationTime, supplierStockObservation } from '../data-freshness.mjs';
import { normalizeSku } from '../sku-successions.mjs';

const sourceWindows = new Map(DATA_SOURCES.map(source => [source.id, source.staleAfterMinutes]));
const clockSkewMs = 5 * 60_000;
const enquiry = balance => `Stock availability${balance ? ' for the balance' : ''} on enquiry.`;

function quantityOrNull(value) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const quantity = Number(value);
  return Number.isFinite(quantity) && quantity >= 0 ? quantity : null;
}

function currentObservation(observedAt, source, nowMs) {
  const timestamp = observationTime(observedAt);
  const minutes = sourceWindows.get(source);
  if (!timestamp || !Number.isFinite(minutes)) return false;
  const age = nowMs - Date.parse(timestamp);
  return age >= -clockSkewMs && age <= minutes * 60_000;
}

function futureDate(value, today) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value <= today) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function supplierDate(product, needed, backorders, nowMs) {
  const article = normalizeSku('victron', product.sku);
  if (!article) return null;
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(nowMs));
  const part = type => parts.find(value => value.type === type).value;
  const today = `${part('year')}-${part('month')}-${part('day')}`;
  const dates = backorders.flatMap(row => {
    if (!row || row.last_error || normalizeSku('victron', row.sku) !== article
      || !currentObservation(row.observed_at, 'victron-orders', nowMs)) return [];
    const date = futureDate(row.planned_for, today);
    const quantity = quantityOrNull(row.quantity);
    return date && quantity > 0 ? [{ date, quantity }] : [];
  }).sort((left, right) => left.date.localeCompare(right.date));
  let available = 0;
  for (const row of dates) {
    available += row.quantity;
    if (available >= needed) return new Date(`${row.date}T00:00:00Z`).toLocaleDateString('en-ZA', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    });
  }
  return null;
}

/**
 * Describe the selected article using stored source observations only. A retail
 * R suffix aliases Victron packaging; successor articles never supply this SKU.
 * Backorders must already exclude inbound duplicates and accepted reservations,
 * using current reservation evidence. Their quantities represent uncommitted
 * future supply, and their dates remain estimates rather than a delivery promise.
 */
export function quoteAvailability(stockProduct, quantity, { now = new Date(), backorders = [] } = {}) {
  const requested = quantityOrNull(quantity);
  const nowMs = new Date(now).getTime();
  if (!stockProduct || requested === null || requested <= 0 || !Number.isFinite(nowMs)) return enquiry(false);

  const details = stockProduct.details || {};
  const local = localStockObservation(stockProduct);
  const localQuantity = quantityOrNull(details.localStockOnHand) !== null
    && currentObservation(local.observedAt, 'thanda', nowMs) ? local.quantity : null;
  if (localQuantity !== null && localQuantity >= requested) return 'Stock available. Subject to prior sale.';

  const balance = localQuantity !== null && localQuantity > 0;
  const needed = requested - (balance ? localQuantity : 0);
  const prefix = balance ? `x${localQuantity} available in stock. Subject to prior sale.\n` : '';
  const qualifier = balance ? ' for the balance' : '';
  const supplier = String(stockProduct.supplier || '').trim().toLowerCase();
  if (details.cataloguePresent === false || !['renogy', 'victron'].includes(supplier)) return prefix + enquiry(balance);

  const observation = supplierStockObservation({ ...stockProduct, supplier });
  if (quantityOrNull(stockProduct.stock_on_hand) !== null && observation.quantity !== null
    && observation.quantity >= needed && currentObservation(observation.observedAt, supplier, nowMs)) {
    return `${prefix}Estimated lead time${qualifier}: ${supplier === 'renogy' ? '2-4' : '5-7'} working days, subject to confirmation.`;
  }
  const date = supplier === 'victron' && Array.isArray(backorders) ? supplierDate(stockProduct, needed, backorders, nowMs) : null;
  if (date) return `${prefix}Estimated lead time${qualifier}: around ${date}, plus 5-7 working days. Subject to supplier confirmation; timing may change.`;
  return prefix + enquiry(balance);
}

// Keep this decision alongside the wording so ordinary stocked quotes do not
// depend on optional planning caches. Those caches can only refine an enquiry.
export function quoteNeedsBackorderEstimate(stockProduct, quantity, now = new Date()) {
  if (String(stockProduct?.supplier || '').trim().toLowerCase() !== 'victron'
    || stockProduct.details?.cataloguePresent === false) return false;
  const note = quoteAvailability(stockProduct, quantity, { now });
  return note === enquiry(false) || note.endsWith(enquiry(true));
}
