import pool from '@/lib/db';
import { DATA_SOURCES, localStockObservation, supplierStockObservation, observationTime, summarizeSource } from './data-freshness.mjs';

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
export type DataSourceStatus = StockSourceStatus & { lastError: string | null };
export type DataHealth = { checkedAt: string; sources: DataSourceStatus[] };
type StoredState = Record<string, unknown>;

async function optionalRows(sql: string): Promise<StoredState[]> {
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

export async function getDataHealth(): Promise<DataHealth> {
  // All reads are local. Do not ask the Hub, Xero or a supplier for dashboard
  // evidence: this page must remain usable while an upstream service is down.
  const [products, runs, orderRows, quoteRows, invoiceRows, creditRows] = await Promise.all([
    optionalRows(`SELECT supplier, sku, stock_on_hand, details FROM products WHERE COALESCE((details->>'hidden')::boolean, false)=false`),
    optionalRows('SELECT * FROM data_sync_status'),
    optionalRows('SELECT * FROM victron_order_sync_state WHERE id=true'),
    optionalRows('SELECT * FROM xero_accepted_quote_sync_state WHERE id=true'),
    optionalRows('SELECT * FROM xero_invoice_sync_state WHERE id=true'),
    optionalRows('SELECT * FROM xero_credit_note_sync_state WHERE id=true'),
  ]);
  const checkedAt = new Date().toISOString();
  const bySource = new Map(runs.map(row => [row.source_id, row]));
  const sources = DATA_SOURCES.map(source => {
    let observations: Array<{ quantity: number | null; observedAt: string | null }> = [];
    let run: StoredState = bySource.get(source.id) || {};
    if (source.id === 'thanda') {
      observations = products.filter(row => row.supplier === 'victron' || row.supplier === 'lora').map(localStockObservation);
    } else if (['victron', 'renogy', 'hubble', 'lora'].includes(source.id)) {
      observations = products.filter(row => row.supplier === source.id).map(supplierStockObservation);
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
    return summarizeSource(source, observations, run, new Date(checkedAt)) as DataSourceStatus;
  });
  return { checkedAt, sources };
}

export async function getCatalogueStatus(): Promise<{ checkedAt: string; sources: StockSourceStatus[] }> {
  const health = await getDataHealth();
  return {
    checkedAt: health.checkedAt,
    sources: health.sources.filter(source => ['thanda', 'victron', 'renogy', 'hubble', 'lora'].includes(source.id))
      .map(({ lastError, ...row }) => { void lastError; return row; }),
  };
}
