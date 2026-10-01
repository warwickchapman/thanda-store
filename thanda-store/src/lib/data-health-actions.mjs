import { localStockObservation, supplierStockObservation } from './data-freshness.mjs';
import { activeStockReview } from './stock-review.mjs';

// Stored evidence only: displaying remedies must never trigger a provider call.
export function stockHealthIssues(source, products, now = new Date()) {
  if (source.mode === 'manual') return [];
  return products.flatMap(product => {
    const local = source.id === 'thanda';
    const managedInventory = product.details?.storeManaged === true && product.details?.xeroStockStatus !== 'untracked';
    if (local ? !['victron', 'lora'].includes(product.supplier) && !managedInventory : product.supplier !== source.id) return [];
    if (local && activeStockReview(product)) return [];
    const observation = local ? localStockObservation(product) : supplierStockObservation(product);
    const details = product.details || {};
    let reason = '';
    let remedy = '';
    if (local && details.xeroStockStatus === 'missing') {
      reason = 'SKU not found in the imported Xero item list';
      remedy = 'Check the article code in Xero Products and services. Correct a code mismatch or create the tracked item if you hold this stock. If it is a predecessor, check its Details relationship in Replenishment. After correcting Xero, allow the next stock sync and check status again.';
    } else if (local && details.xeroStockStatus === 'untracked') {
      reason = 'Xero item is not tracked as inventory';
      remedy = 'Ask the bookkeeper to review inventory tracking for this item in Xero. If this is a service or non-stock line, ask the Store maintainer to exclude it from stock planning. Repeated refreshes will not fix its configuration.';
    } else if (observation.quantity === null || !observation.observedAt) {
      reason = observation.observedAt ? 'Source did not provide a usable stock quantity' : 'No confirmed stock observation';
      remedy = local
        ? 'Check that the exact SKU is a tracked item with a quantity in Xero. If it is correct there, ask the Store maintainer to check the Hub Items snapshot and stock import.'
        : 'Check this SKU in the supplier portal. If it is available there, ask the Store maintainer to review catalogue matching and the supplier response. A missing observation does not confirm zero stock.';
    } else if (Date.parse(observation.observedAt) > new Date(now).getTime() + 300_000) {
      reason = 'Observation time is in the future';
      remedy = 'Ask the Store maintainer to check the source timestamp and server clock.';
    } else if (new Date(now).getTime() - Date.parse(observation.observedAt) > source.staleAfterMinutes * 60_000) {
      reason = 'Stock observation is overdue';
      remedy = 'Follow the source recovery steps above. The saved quantity remains visible while the scheduled update recovers.';
    }
    return reason ? [{ sku: product.sku, name: product.name || '', reason, remedy, observedAt: observation.observedAt }] : [];
  }).sort((a, b) => a.sku.localeCompare(b.sku));
}

export function sourceRecovery(source) {
  const local = ['thanda', 'sales', 'accepted-quotes'].includes(source.id);
  const actions = [];
  if (/HTTP 429/.test(source.lastError || '')) {
    actions.push('The provider has rate-limited requests. Allow the scheduled job to retry after the provider cooldown; do not repeatedly refresh the source. If the next scheduled run also fails, send the downloaded diagnostic report to the Store maintainer to review request frequency and the retry deadline.');
  } else if (/HTTP 40[13]/.test(source.lastError || '')) {
    actions.push(local
      ? 'Ask the Store maintainer to review the shared Xero Hub connection and permissions. Check Xero connection status in Settings.'
      : 'Ask the Store maintainer to renew the supplier credentials or session. A stock refresh cannot repair authentication.');
  } else if (source.status === 'error' || source.status === 'stale') {
    actions.push('Check again after the next scheduled update. If it still fails, download the diagnostic report for the Store maintainer to check the scheduled job and provider response. Saved quantities remain available.');
  }
  if (source.id === 'thanda') actions.push('Review the affected SKUs below. Missing Xero items and untracked inventory require an item or mapping correction, not another refresh. Stock imports run every 30 minutes from the shared Hub.');
  if (source.id === 'victron') actions.push('Victron stock is checked every four hours. Review Victron API activity for request counts and cooldown deadlines; Retry catalogue is available outside the cooldown. Confirm availability in E-Order if ordering before recovery. Supplier availability warnings do not change the calculated order quantity.');
  if (source.id === 'renogy') actions.push('Renogy stock is checked every five minutes. For individual missing items, verify the SKU in the supplier portal and ask the Store maintainer to check its catalogue mapping.');
  if (source.id === 'sales') actions.push('Sales and credit history is imported daily. If incomplete, ask the Store maintainer to check both invoice and credit-note snapshots in the shared Hub before retrying the import.');
  if (source.id === 'accepted-quotes') actions.push('Quote reservations are checked every 30 minutes. Use Check accepted quotes on Replenishment for an immediate check; if it fails, download the diagnostic report for the Store maintainer.');
  if (source.id === 'victron-orders') actions.push('Shipments and backorders are checked hourly. Review Inbound to confirm physical receipts; use its existing sync control when an immediate update is needed, unless the provider is rate-limiting requests.');
  return actions;
}
