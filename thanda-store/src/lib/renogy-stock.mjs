import { observationTime } from './data-freshness.mjs';

function stockQuantity(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+(?:\.0+)?$/.test(value.trim())) return null;
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) && quantity >= 0 ? quantity : null;
}

// The partner portal displays `availble`, not the unrelated `inventory` field.
// Backorder capacity and warehouse/safety totals must never manufacture stock.
export function observeRenogyStock(detail = {}, row = {}, observedAt) {
  const available = stockQuantity(detail.availble);
  if (available !== null) {
    return { quantity: available, observedAt: observationTime(observedAt), source: 'renogy-detail.availble' };
  }
  const exported = stockQuantity(row.Stock);
  if (exported !== null && ['renogy-export', 'warehouse-csv'].includes(row.source)) {
    return {
      quantity: exported,
      observedAt: row.source === 'renogy-export' ? observationTime(row.stockObservedAt) : null,
      source: row.source === 'renogy-export' ? 'renogy-export.Available' : 'warehouse-csv.Stock',
    };
  }
  return { quantity: null, observedAt: null, source: null };
}
