// Freshness is based on source observations, never a product's last_updated or
// the time a cached Hub snapshot was imported. No network or database access.
// Allow several scheduled runs before warning: Renogy 5m, Victron/orders 1h,
// Thanda/accepted quotes 30m, sales history daily. These are warning thresholds,
// not promises that the source was contacted on that schedule.
export const DATA_SOURCES = [
  { id: 'thanda', label: 'Thanda stock', supplier: null, mode: 'scheduled', staleAfterMinutes: 120 },
  { id: 'victron', label: 'Victron supplier stock', supplier: 'victron', mode: 'scheduled', staleAfterMinutes: 180 },
  { id: 'renogy', label: 'Renogy supplier stock', supplier: 'renogy', mode: 'scheduled', staleAfterMinutes: 20 },
  { id: 'hubble', label: 'Hubble availability', supplier: 'hubble', mode: 'manual', staleAfterMinutes: null },
  { id: 'lora', label: 'LoRa supplier stock', supplier: 'lora', mode: 'manual', staleAfterMinutes: null },
  { id: 'sales', label: 'Sales and credit history', supplier: null, mode: 'scheduled', staleAfterMinutes: 2160 },
  { id: 'victron-orders', label: 'Victron shipments and backorders', supplier: 'victron', mode: 'scheduled', staleAfterMinutes: 180 },
  { id: 'accepted-quotes', label: 'Accepted quote reservations', supplier: null, mode: 'scheduled', staleAfterMinutes: 120 },
];

export function observationTime(value) {
  if (!value || (typeof value !== 'string' && !(value instanceof Date))) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function quantityOrNull(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

// The normal catalogue sync and the explicit new-SKU import use the same
// warehouse precedence. A source response with no quantity is not zero stock.
export function observeVictronSupplierStock(product, observedAt) {
  const quantity = quantityOrNull(product.all_stock_by_warehouse?.af_sa_inzuzo)
    ?? quantityOrNull(product.stock_quantity);
  return { quantity, observedAt: observationTime(observedAt), status: quantity === null ? 'unknown' : 'known' };
}

export function localStockObservation(product) {
  const details = product.details || {};
  const observedAt = observationTime(details.xeroStockSyncedAt);
  return {
    quantity: observedAt && details.xeroStockStatus === 'tracked' ? quantityOrNull(details.localStockOnHand) : null,
    observedAt,
  };
}

export function supplierStockObservation(product) {
  const details = product.details || {};
  const manual = ['hubble', 'lora'].includes(product.supplier) || details.supplierStockManaged === false;
  const observedAt = manual ? null : observationTime(details.supplierObservedAt);
  return {
    quantity: observedAt && details.supplierStockStatus !== 'unknown' ? quantityOrNull(product.stock_on_hand) : null,
    observedAt,
  };
}

export function summarizeSource(source, observations = [], run = {}, now = new Date()) {
  const nowMs = new Date(now).getTime();
  const times = observations.map(row => observationTime(row.observedAt)).filter(Boolean).sort();
  const thresholdMs = source.staleAfterMinutes === null ? null : source.staleAfterMinutes * 60_000;
  // Clock skew beyond five minutes is not reliable source evidence.
  const missingCount = observations.filter(row => row.quantity === null || !observationTime(row.observedAt)
    || Date.parse(row.observedAt) > nowMs + 300_000).length;
  const staleCount = thresholdMs === null ? 0 : times.filter(value => nowMs - Date.parse(value) > thresholdMs).length;
  const observedAt = times[0] || null;
  const latestObservedAt = times.at(-1) || null;
  const failure = ['failed', 'partial'].includes(run.last_status);
  const status = source.mode === 'manual' ? 'manual' : failure ? 'error'
    : !observedAt || missingCount > 0 ? 'missing' : staleCount > 0 ? 'stale' : 'current';
  const messages = {
    current: 'Stored observations are within the expected update window.',
    stale: 'The last observed data is overdue for an update.',
    missing: 'Some stock or source observations are unknown.',
    error: run.last_status === 'partial' ? 'The latest update was incomplete; some retained data may be older.' : 'The latest update failed; retained data is shown.',
    manual: source.id === 'lora' ? 'No supplier feed; Thanda stock is shown separately.' : 'Availability is maintained manually.',
  };
  return {
    ...source, status, observedAt, latestObservedAt,
    totalCount: observations.length,
    missingCount: source.mode === 'manual' ? 0 : missingCount,
    staleCount,
    lastAttemptAt: observationTime(run.last_started_at),
    lastSuccessAt: observationTime(run.last_successful_at),
    lastRunStatus: run.last_status || null,
    message: messages[status],
    lastError: failure ? safeSyncError(run.last_error) : null,
  };
}

// Error bodies can contain signed URLs, customer details or credentials. Keep
// only a useful bounded category in the shared status table/UI; service logs
// already contain the original exception for an operator's investigation.
export function safeSyncError(error) {
  const message = String(error?.message || error || '');
  const http = message.match(/(?:HTTP|status|failed:)\s*(\d{3})\b/i);
  if (http) return `Source request failed (HTTP ${http[1]}). Check the service log.`;
  if (/abort|timed? ?out|timeout/i.test(message)) return 'The source request timed out. Check the service log.';
  if (/partial|incomplete|not found|missing|failed product/i.test(message)) return 'The update was incomplete. Check the service log.';
  return 'The update failed. Check the service log.';
}
