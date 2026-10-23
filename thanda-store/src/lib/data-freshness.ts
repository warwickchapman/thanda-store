import pool from '@/lib/db';
import { DATA_SOURCES, localStockObservation, supplierStockObservation, observationTime, summarizeSource } from './data-freshness.mjs';
import { awaitingCatalogueStockImports, sourceRecovery, stockHealthIssues, supplierLifecycleActions, supplierStockScope } from './data-health-actions.mjs';
import { activeStockReview } from './stock-review.mjs';
import { loadInventoryScope } from './inventory-scope.mjs';
import { stockSku } from './victron-sku-family.mjs';

export type StockSourceStatus = {
  id: string;
  label: string;
  supplier: string | null;
  mode: 'scheduled' | 'manual';
  status: 'current' | 'stale' | 'missing' | 'error' | 'manual';
  feedStatus: 'current' | 'stale' | 'missing' | 'error' | 'manual';
  feedMessage: string;
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
  actionableIssueCount?: number;
  awaitingStockImportCount?: number;
  awaitingStockImports?: Array<{ sku: string; name: string; createdAt: string }>;
  lifecycleCount?: number;
  lifecycleActionCount?: number | null;
  lifecycleReviewMessage?: string;
  lifecycleItems?: Array<{ sku: string; name: string; observedAt: string | null }>;
  lifecycleReviewUrl?: string;
  recovery?: string[];
  issues?: Array<{ sku: string; name: string; reason: string; remedy: string; observedAt: string | null;
    kind: string; owner: string; actionLabel?: string; actionUrl?: string }>;
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
  const [products, runs, orderRows, quoteRows, invoiceRows, creditRows, reviews, victronCooldowns, successions, creations, catalogueReviews, archives] = await Promise.all([
    optionalRows('SELECT supplier, sku, name, stock_on_hand, details FROM products'),
    optionalRows('SELECT * FROM data_sync_status'),
    optionalRows('SELECT * FROM victron_order_sync_state WHERE id=true'),
    optionalRows('SELECT * FROM xero_accepted_quote_sync_state WHERE id=true'),
    optionalRows('SELECT * FROM xero_invoice_sync_state WHERE id=true'),
    optionalRows('SELECT * FROM xero_credit_note_sync_state WHERE id=true'),
    optionalRows('SELECT * FROM product_stock_reviews'),
    optionalRows("SELECT scope, MAX(blocked_until) AS blocked_until FROM victron_http_state WHERE blocked_until>NOW() GROUP BY scope"),
    optionalRows<{ predecessor_sku: string; successor_sku: string }>('SELECT predecessor_sku, successor_sku FROM victron_sku_successions'),
    // Reuse confirmed catalogue commands; this local, bounded read adds no
    // Hub/Xero request and cannot reclassify another company's stock.
    optionalRows(`SELECT e.company,UPPER(proposal->>'code') AS sku,e.created_at,e.details->>'confirmedAt' AS confirmed_at
      FROM victron_catalogue_events e CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(e.details->'request'->'payload'->'proposals')='array'
          THEN e.details->'request'->'payload'->'proposals'
          ELSE jsonb_build_array(e.details->'request'->'payload') END) proposal
      WHERE e.company='thanda-solar' AND e.action IN ('applied','batch-applied')
        AND e.created_at >= NOW() - interval '125 minutes'
        AND proposal->>'action'='new' AND NULLIF(proposal->>'code','') IS NOT NULL`),
    includeIssues ? optionalRows('SELECT checked_at,observed_at,rows,history,error FROM victron_catalogue_review WHERE id=true') : Promise.resolve([]),
    includeIssues ? optionalRows("SELECT company,sku,max(created_at) AS completed_at FROM victron_catalogue_events WHERE company='thanda-solar' AND action='archive-reviewed' GROUP BY company,sku") : Promise.resolve([]),
  ]);
  const reviewsBySku = new Map(reviews.map(row => [`${row.supplier}:${row.sku}`, row]));
  for (const product of products) product.stockReview = reviewsBySku.get(`${product.supplier}:${product.sku}`);
  const checkedAt = new Date().toISOString();
  const bySource = new Map(runs.map(row => [row.source_id, row]));
  const visibleProducts = products.filter(row => ![true, 'true'].includes((row.details as StoredState)?.hidden as boolean | string));
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
  const awaitingStockImports: Array<{ sku: string; name: string; createdAt: string }> = awaitingCatalogueStockImports(inventoryScope.stockProducts, creations,
    { observedAt: inventoryScope.observedAt, complete: inventoryScope.complete, now: new Date(checkedAt) });
  const awaitingArticles = new Set(awaitingStockImports.map(row => stockSku(row.sku)));
  // Only presentation waits. The internal inventory scope returned to planning
  // still contains the article's unknown balance until a real stock import.
  const presentedStockProducts = stockProducts.filter(row => row.supplier !== 'victron' || !awaitingArticles.has(stockSku(row.sku)));
  const sources = DATA_SOURCES.map(source => {
    let observations: Array<{ quantity: number | null; observedAt: string | null }> = [];
    let run: StoredState = bySource.get(source.id) || {};
    if (source.id === 'thanda') {
      run = { ...run, source_observed_at: run.source_observed_at ?? inventoryScope.observedAt };
      observations = presentedStockProducts.filter(row => (row.supplier === 'victron' || row.supplier === 'lora'
        || ((row.details as StoredState)?.storeManaged === true && (row.details as StoredState)?.xeroStockStatus !== 'untracked'))
        && (row.supplier === 'victron' || !activeStockReview(row))).map(localStockObservation);
    } else if (['victron', 'renogy', 'hubble', 'lora'].includes(source.id)) {
      observations = supplierStockScope(source.id, visibleProducts, new Date(checkedAt)).activeProducts.map(supplierStockObservation);
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
    const supplierScope = supplierStockScope(source.id, visibleProducts, new Date(checkedAt));
    status.lifecycleCount = supplierScope.lifecycleItems.length;
    if (includeIssues) {
      status.lifecycleItems = supplierScope.lifecycleItems;
      Object.assign(status, supplierLifecycleActions(source.id, supplierScope.lifecycleItems, catalogueReviews[0], archives, new Date(checkedAt)));
    }
    if (status.lifecycleCount) status.lifecycleReviewUrl = source.id === 'victron'
      ? '/admin/victron-catalogue?company=thanda-solar' : '/admin/products';
    // When every supplier product has been removed, retain the actual complete
    // catalogue observation instead of manufacturing a stock-zero placeholder.
    if (!observations.length && status.lifecycleCount > 0) {
      status.status = status.feedStatus;
      status.observedAt = status.latestObservedAt = observationTime(run.source_observed_at);
      status.message = status.feedMessage;
    }
    if (source.id === 'thanda') {
      status.awaitingStockImportCount = awaitingStockImports.length;
      if (includeIssues) status.awaitingStockImports = awaitingStockImports;
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
      if (status.awaitingStockImportCount && status.status === 'current') status.message = 'Xero confirmed new product additions. Their stock records are waiting for the normal import; no repeat addition is needed.';
    }
    const cooldownScopes = source.id === 'victron' ? ['catalogue','account'] : source.id === 'victron-orders' ? ['orders','account'] : [];
    const retryAt = Math.max(0, ...victronCooldowns.filter(row => cooldownScopes.includes(String(row.scope))).map(row => new Date(String(row.blocked_until)).getTime()));
    if (retryAt > Date.now()) status.message = `Victron requested a cooldown until ${new Date(retryAt).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })} SAST. Retained data is shown; scheduled attempts skip locally until then.`;
    const issues = stockHealthIssues(source, source.id === 'thanda' ? presentedStockProducts : visibleProducts, new Date(checkedAt));
    status.actionableIssueCount = issues.length;
    if (includeIssues) {
      status.recovery = sourceRecovery(status);
      status.issues = issues;
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
