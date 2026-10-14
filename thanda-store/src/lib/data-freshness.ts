import pool from '@/lib/db';
import { DATA_SOURCES, localStockObservation, supplierStockObservation, observationTime, summarizeSource } from './data-freshness.mjs';
import { sourceRecovery, stockHealthIssues } from './data-health-actions.mjs';
import { activeStockReview } from './stock-review.mjs';
import { loadInventoryScope } from './inventory-scope.mjs';

export type StockSourceStatus = {
  id: string;
  label: string;
  supplier: string | null;
  mode: 'scheduled' | 'manual';
  status: 'current' | 'stale' | 'missing' | 'error' | 'manual';
  observedAt: string | null;
  latestObservedAt: string | null;
  totalCount: number;
  missingCount: number;
  staleCount: number;
  staleAfterMinutes: number | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastRunStatus: 'running' | 'success' | 'partial' | 'failed' | 'skipped' | null;
  message: string;
};
export type DataSourceStatus = StockSourceStatus & {
  lastError: string | null;
  catalogueOnlyCount?: number;
  inventoryScopeMessage?: string | null;
  recovery?: string[];
  issues?: Array<{ sku: string; name: string; reason: string; remedy: string; observedAt: string | null }>;
};
export type StockReviewItem = {
  supplier: string; sku: string; name: string; xeroStatus: string;
  decision: 'do_not_stock' | 'retired' | null; active: boolean;
  note: string; reviewedAt: string | null; observedAt: string | null;
  family: string; familySkus: string[];
  purchasingRetiredReason?: string | null; creationPending?: boolean;
  purchasingRestored?: boolean;
  replaces: string[]; replacedBy: string[];
};
export type DataHealth = {
  checkedAt: string; sources: DataSourceStatus[]; stockReviews?: StockReviewItem[];
  // Internal planning evidence. Maps are never included in the public status DTO.
  inventoryScope?: Awaited<ReturnType<typeof loadInventoryScope>>;
};
type StoredState = Record<string, unknown>;

async function optionalRows<T = StoredState>(sql: string): Promise<T[]> {
  try {
    return (await pool.query(sql)).rows;
  } catch (error) {
    // A new installation has no successful observation before the first sync.
    // Missing tables mean unknown evidence; connection/query failures do not.
    if ((error as { code?: string }).code === '42P01') return [];
    throw error;
  }
}

function existingRun(row: StoredState | undefined, observedAt: unknown, sourceId: string) {
  return {
    last_started_at: row?.last_started_at,
    // Quote state historically used last_successful_sync_at for the Hub's
    // observation. It cannot also stand in for a local import completion.
    last_successful_at: sourceId === 'victron-orders' ? row?.last_successful_sync_at : null,
    last_status: row?.last_error ? 'failed' : observationTime(observedAt) ? 'success' : null,
    last_error: row?.last_error,
  };
}

export async function getDataHealth({ includeIssues = false, includeInventoryScope = false } = {}): Promise<DataHealth> {
  // All reads are local. Do not ask the Hub, Xero or a supplier for dashboard
  // evidence: this page must remain usable while an upstream service is down.
  const [products, runs, orderRows, quoteRows, invoiceRows, creditRows, reviews, victronCooldowns, successions] = await Promise.all([
    optionalRows('SELECT supplier, sku, name, stock_on_hand, details FROM products'),
    optionalRows('SELECT * FROM data_sync_status'),
    optionalRows('SELECT * FROM victron_order_sync_state WHERE id=true'),
    optionalRows('SELECT * FROM xero_accepted_quote_sync_state WHERE id=true'),
    optionalRows('SELECT * FROM xero_invoice_sync_state WHERE id=true'),
    optionalRows('SELECT * FROM xero_credit_note_sync_state WHERE id=true'),
    optionalRows('SELECT * FROM product_stock_reviews'),
    optionalRows("SELECT scope, MAX(blocked_until) AS blocked_until FROM victron_http_state WHERE blocked_until>NOW() GROUP BY scope"),
    optionalRows<{ predecessor_sku: string; successor_sku: string }>('SELECT predecessor_sku, successor_sku FROM victron_sku_successions'),
  ]);
  const reviewsBySku = new Map(reviews.map(row => [`${row.supplier}:${row.sku}`, row]));
  for (const product of products) product.stockReview = reviewsBySku.get(`${product.supplier}:${product.sku}`);
  const checkedAt = new Date().toISOString();
  const bySource = new Map(runs.map(row => [row.source_id, row]));
  const visibleProducts = products.filter(row => (row.details as StoredState)?.hidden !== true);
  // Order imports predate data_sync_status. Reuse their retained successful
  // observation rather than requiring a second job or a provider request.
  const orderObservedAt = observationTime(orderRows[0]?.last_successful_sync_at);
  const scopeRuns = [...runs.filter(row => row.source_id !== 'victron-orders'), {
    source_id: 'victron-orders', source_observed_at: orderObservedAt,
    ...existingRun(orderRows[0], orderObservedAt, 'victron-orders'),
    ...bySource.get('victron-orders'),
  }];
  const inventoryScope = await loadInventoryScope(pool, { products, successions, runs: scopeRuns, now: Date.parse(checkedAt) });
  const stockProducts = [...inventoryScope.stockProducts, ...visibleProducts.filter(row => row.supplier !== 'victron')];
  const sources = DATA_SOURCES.map(source => {
    let observations: Array<{ quantity: number | null; observedAt: string | null }> = [];
    let run: StoredState = bySource.get(source.id) || {};
    if (source.id === 'thanda') {
      observations = stockProducts.filter(row => (row.supplier === 'victron' || row.supplier === 'lora'
        || ((row.details as StoredState)?.storeManaged === true && (row.details as StoredState)?.xeroStockStatus !== 'untracked'))
        && (row.supplier === 'victron' || !activeStockReview(row))).map(localStockObservation);
    } else if (['victron', 'renogy', 'hubble', 'lora'].includes(source.id)) {
      observations = visibleProducts.filter(row => row.supplier === source.id).map(supplierStockObservation);
    } else if (source.id === 'sales') {
      // The old last_successful_sync_at was import time. Never relabel it as
      // source freshness; source_observed_at is populated by the next job.
      observations = [invoiceRows[0], creditRows[0]].map(row => ({
        quantity: observationTime(row?.source_observed_at) ? 1 : null,
        observedAt: observationTime(row?.source_observed_at),
      }));
    } else {
      const row = source.id === 'victron-orders' ? orderRows[0] : quoteRows[0];
      // Existing quote state already stores Hub observation time; E-Order is
      // fetched directly in its scheduled job, so completion is observation.
      const observedAt = observationTime(row?.last_successful_sync_at);
      observations = [{ quantity: observedAt ? 1 : null, observedAt }];
      run = { ...existingRun(row, observedAt, source.id), ...run };
    }
    const status = summarizeSource(source, observations, run, new Date(checkedAt)) as DataSourceStatus;
    if (source.id === 'thanda') {
      status.catalogueOnlyCount = inventoryScope.catalogueOnly.length;
      status.inventoryScopeMessage = inventoryScope.reason;
      // An empty inventory subset is not proof of a healthy import. Keep the
      // full collection's actual timestamp/outcome; do not invent a stock row.
      if (!observations.length) {
        const observed = observationTime(inventoryScope.observedAt);
        status.observedAt = status.latestObservedAt = observed;
        if (!['failed', 'partial'].includes(String(run.last_status))) {
          status.status = !observed || Date.parse(observed) > Date.parse(checkedAt) + 300_000
            ? 'missing' : Date.parse(checkedAt) - Date.parse(observed) > source.staleAfterMinutes! * 60_000 ? 'stale' : !inventoryScope.complete ? 'missing' : 'current';
        }
        status.message = status.status === 'current' ? 'The saved inventory list is current. No inventory articles require a stock record.'
          : status.status === 'error' ? status.message : 'The inventory assessment needs a complete, current saved update.';
      }
    }
    const cooldownScopes = source.id === 'victron' ? ['catalogue','account'] : source.id === 'victron-orders' ? ['orders','account'] : [];
    const retryAt = Math.max(0, ...victronCooldowns.filter(row => cooldownScopes.includes(String(row.scope))).map(row => new Date(String(row.blocked_until)).getTime()));
    if (retryAt > Date.now()) status.message = `Victron requested a cooldown until ${new Date(retryAt).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })} SAST. Retained data is shown; scheduled attempts skip locally until then.`;
    if (includeIssues) {
      status.recovery = sourceRecovery(status);
      status.issues = stockHealthIssues(source, source.id === 'thanda' ? stockProducts : visibleProducts, new Date(checkedAt));
    }
    return status;
  });
  // Victron's worklist belongs to catalogue review. Keep its stock evidence in
  // the source diagnostics above, but never build a second item-review queue.
  const stockReviews = includeIssues ? visibleProducts.filter(product => {
    const details = product.details as Record<string, unknown>;
    return product.supplier === 'lora'
      && (details?.xeroStockStatus === 'missing' || details?.purchasingRetiredReason || reviewsBySku.get(`${product.supplier}:${product.sku}`)?.decision);
  }).map(product => {
    const review = reviewsBySku.get(`${product.supplier}:${product.sku}`);
    const details = product.details as Record<string, unknown>;
    const sku = String(product.sku);
    return {
      supplier: String(product.supplier), sku, name: String(product.name), xeroStatus: String(details?.xeroStockStatus || 'unknown'),
      decision: (review?.decision || null) as StockReviewItem['decision'], active: Boolean(activeStockReview(product)),
      note: String(review?.note || ''), reviewedAt: observationTime(review?.reviewed_at), observedAt: observationTime(details?.xeroStockSyncedAt),
      family: sku, familySkus: [sku], replaces: [], replacedBy: [],
      purchasingRetiredReason: details?.purchasingRetiredReason ? String(details.purchasingRetiredReason) : null,
      creationPending: Boolean(details?.xeroCreatedItemId && details?.xeroStockStatus === 'missing'),
      purchasingRestored: details?.purchasingRetirementOverride === true,
    };
  }).sort((a, b) => a.sku.localeCompare(b.sku)) : undefined;
  return { checkedAt, sources, ...(stockReviews ? { stockReviews } : {}), ...(includeInventoryScope ? { inventoryScope } : {}) };
}

export async function getCatalogueStatus(): Promise<{ checkedAt: string; sources: StockSourceStatus[] }> {
  const health = await getDataHealth();
  return {
    checkedAt: health.checkedAt,
    sources: health.sources.filter(source => ['thanda', 'victron', 'renogy', 'hubble', 'lora'].includes(source.id))
      .map(({ lastError, ...row }) => { void lastError; return row; }),
  };
}
