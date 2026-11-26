/** @typedef {'ready'|'waiting'|'stock'|'unknown'|'stale'} ArchiveStatus */
/** @typedef {{kind?: string, eligibleForArchiveReview?: boolean, stock?: unknown, stockTracked?: boolean|null, itemId?: unknown}} ArchiveRow */
/** @typedef {{overdue?: boolean, error?: unknown}} ArchiveContext */

/**
 * Assess one exact company/SKU from the saved catalogue comparison. Supplier
 * retirement is established by reviewCatalogue, including its two-date absence
 * rule. A replacement family's stock must never stand in for this Xero item.
 * Ready means listed for manual Xero checks, not archived or orders checked.
 * @param {ArchiveRow} row
 * @param {ArchiveContext} context
 * @returns {{status: ArchiveStatus, label: string, blocker: string|null, ready: boolean}}
 */
export function archiveReadiness(row, { overdue = false, error = null } = {}) {
  if (row?.kind !== 'archive') return {
    status: 'waiting', label: 'Waiting for supplier evidence', ready: false,
    blocker: 'This item has not been identified as an archive candidate in the saved supplier comparison.',
  };
  if (overdue || error) return {
    status: 'stale', label: 'Refresh saved comparison', ready: false,
    blocker: 'The saved comparison is overdue or has an error. Compare saved records before using this archive list.',
  };
  if (row.eligibleForArchiveReview !== true) return {
    status: 'waiting', label: 'Waiting for supplier evidence', ready: false,
    blocker: 'Supplier retirement is not confirmed. Missing items need complete supplier observations on two different dates.',
  };
  if (typeof row.itemId !== 'string' || !row.itemId.trim()) return {
    status: 'unknown', label: 'Xero item needs checking', ready: false,
    blocker: 'The exact Xero item identity is unavailable. Compare saved records and confirm the item in the correct company.',
  };
  if (row.stockTracked !== true) return {
    status: 'unknown', label: 'Stock needs checking', ready: false,
    blocker: row.stockTracked === false
      ? 'This Xero item is not tracked as inventory, so zero stock is not verified.'
      : 'Xero inventory tracking is unknown. Confirm tracked stock before archiving.',
  };
  if (typeof row.stock !== 'number' || !Number.isFinite(row.stock)) return {
    status: 'unknown', label: 'Stock unknown', ready: false,
    blocker: 'Company stock is unknown. A recorded zero for this exact SKU is required before archiving.',
  };
  if (row.stock !== 0) return {
    status: 'stock', label: row.stock > 0 ? 'Stock remains' : 'Stock needs checking', ready: false,
    blocker: row.stock > 0
      ? `Company stock is ${row.stock}. Keep this SKU active until its recorded stock reaches zero.`
      : `Company stock is ${row.stock}. Resolve the stock balance before archiving.`,
  };
  return { status: 'ready', label: 'Ready to archive in Xero', blocker: null, ready: true };
}

/**
 * Preserve exact company/SKU rows and their replacement context for the report.
 * No grouping, quantity coercion or retirement inference occurs here.
 * @template {ArchiveRow} T
 * @param {T[]} rows
 * @param {ArchiveContext} context
 * @returns {T[]}
 */
export function archiveReadyRows(rows, context = {}) {
  return rows.filter(row => archiveReadiness(row, context).ready);
}
