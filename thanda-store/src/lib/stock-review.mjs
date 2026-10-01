export const STOCK_REVIEW_DECISIONS = ['do_not_stock', 'retired'];

export function activeStockReview(product) {
  return product.details?.xeroStockStatus === 'missing'
    && (STOCK_REVIEW_DECISIONS.includes(product.stockReview?.decision) || (product.details?.purchasingRetiredReason && !product.details?.purchasingRetirementOverride))
    ? product.stockReview || { decision: 'retired' } : null;
}

export function checkedXeroItem(items, sku, observedAt) {
  const timestamp = new Date(observedAt);
  if (!observedAt || !Number.isFinite(timestamp.getTime()) || timestamp.getTime() > Date.now() + 300_000)
    throw new Error('The saved Xero item list has no reliable observation time.');
  const matches = items.filter(item => String(item.Code || '').trim().toUpperCase() === sku.toUpperCase());
  if (matches.length > 1) throw new Error('More than one Xero item matches this code. Ask the bookkeeper to review it.');
  const item = matches[0];
  const status = !item ? 'missing' : item.IsTrackedAsInventory === true ? 'tracked' : 'untracked';
  const rawQuantity = item?.QuantityOnHand;
  const quantity = status === 'tracked' && rawQuantity !== null && rawQuantity !== undefined && rawQuantity !== ''
    && typeof rawQuantity !== 'boolean' && Number.isFinite(Number(rawQuantity))
    ? Math.max(0, Math.floor(Number(rawQuantity))) : null;
  return { status, quantity, observedAt: timestamp.toISOString() };
}

export async function ensureStockReviewSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS product_stock_reviews (
    supplier TEXT NOT NULL,
    sku TEXT NOT NULL,
    decision TEXT CHECK (decision IN ('do_not_stock', 'retired')),
    note TEXT NOT NULL DEFAULT '',
    reviewed_by BIGINT,
    reviewed_at TIMESTAMPTZ,
    last_checked_at TIMESTAMPTZ,
    PRIMARY KEY (supplier, sku)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS product_stock_review_events (
    id BIGSERIAL PRIMARY KEY,
    supplier TEXT NOT NULL,
    sku TEXT NOT NULL,
    action TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    actor_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}
