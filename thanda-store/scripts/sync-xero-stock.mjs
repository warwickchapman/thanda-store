#!/usr/bin/env node

import { hubFetch, hubStatus } from '../src/lib/xero/hub.mjs';
import { startDataSync, finishDataSync } from '../src/lib/data-sync-state.mjs';
import { matchingXeroItem } from '../src/lib/admin/store-products.mjs';
import { saveInventoryEvidence, inventoryQuantity } from '../src/lib/inventory-scope.mjs';

import { createPool, ensureProductSchema } from './product-sync-lib.mjs';

const ITEMS_URL = '/Items';

function normalizeSku(value) {
  return String(value || '').trim().toUpperCase();
}

function quantityOnHand(item) {
  if (item?.IsTrackedAsInventory !== true) return null;
  const quantity = inventoryQuantity(item.QuantityOnHand);
  return quantity === null ? null : Math.floor(quantity);
}

function moneyOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 100) / 100;
}

async function fetchXeroItems(client, token) {
  if (!token.tenant_id) throw new Error('Xero Hub connection has no tenant identity');

  const response = await hubFetch(ITEMS_URL, {
    headers: {
      Accept: 'application/json',
    },
  });

  const responseText = await response.text();

  let payload = {};
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new Error(`Xero Items returned non-JSON: ${response.status} ${response.statusText}`);
  }
  if (!response.ok) {
    throw new Error(`Xero Items fetch failed: ${response.status} ${response.statusText}`);
  }

  if (!Array.isArray(payload.Items) || payload._hub?.company !== 'thanda-solar' || payload._hub.last_error) {
    throw new Error('Complete Thanda Xero Items evidence is required');
  }
  const items = payload.Items;
  console.error(`Fetched Xero Items: ${items.length}`);
  return { items, observedAt: payload._hub.observed_at, snapshot: payload._hub.snapshot, company: payload._hub.company };
}

async function ensureSyncState(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS xero_stock_sync_state (
      id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
      refresh_requested_at TIMESTAMPTZ,
      last_started_at TIMESTAMPTZ,
      last_completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query('INSERT INTO xero_stock_sync_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING');
  await client.query(`
    CREATE TABLE IF NOT EXISTS xero_api_usage (
      id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
      day_limit_remaining INTEGER,
      minute_limit_remaining INTEGER,
      app_minute_limit_remaining INTEGER,
      rate_limit_problem TEXT,
      retry_after_seconds INTEGER,
      next_allowed_at TIMESTAMPTZ,
      source TEXT,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query('ALTER TABLE xero_api_usage ADD COLUMN IF NOT EXISTS next_allowed_at TIMESTAMPTZ');
}


async function targetProducts(client) {
  const result = await client.query(`
    SELECT supplier, sku, details
    FROM products
    WHERE supplier = 'victron'
       OR (supplier = 'lora' AND sku = 'LORA-RS-00120')
       OR details->>'storeManaged' = 'true'
    ORDER BY supplier, sku
  `);
  return result.rows;
}

async function updateLocalStock(client, product, localStock, xeroItem, observedAt) {
  const xeroSalesPrice = moneyOrNull(xeroItem?.SalesDetails?.UnitPrice);
  const xeroPurchasePrice = moneyOrNull(xeroItem?.PurchaseDetails?.UnitPrice);
  const shouldSyncXeroPrice = product.supplier === 'lora' && product.details?.storeManaged !== true;

  await client.query(
    `
      UPDATE products
      SET name = CASE
            WHEN $5::boolean AND NULLIF($6::text, '') IS NOT NULL THEN $6::text
            ELSE name
          END,
          price = CASE
            WHEN $5::boolean AND $7::numeric IS NOT NULL THEN $7::numeric
            ELSE price::numeric
          END,
          details = jsonb_set(
            jsonb_set(
              jsonb_set(
                CASE
                  WHEN $5::boolean AND $8::numeric IS NOT NULL THEN
                    details
                    || jsonb_build_object(
                      'originalPrice', $8::numeric,
                      'recommendedRetailExVat', $8::numeric,
                      'recommendedRetailPriceVatMode', 'ex_vat',
                      'xeroSalesUnitPrice', $8::numeric,
                      'xeroPurchaseUnitPrice', $7::numeric
                    )
                  ELSE details
                END,
                '{localStockOnHand}',
                COALESCE(to_jsonb($3::int), 'null'::jsonb),
                true
              ),
              '{xeroStockSyncedAt}',
              to_jsonb(to_char($9::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
              true
            ),
            '{xeroStockStatus}',
            to_jsonb($4::text),
            true
          ),
          last_updated = NOW()
      WHERE supplier = $1 AND sku = $2
    `,
    [
      product.supplier,
      product.sku,
      localStock,
      xeroItem
        ? (xeroItem.IsTrackedAsInventory === true ? 'tracked' : 'untracked')
        : 'missing',
      shouldSyncXeroPrice,
      xeroItem?.Name || '',
      xeroPurchasePrice,
      xeroSalesPrice,
      observedAt,
    ],
  );
}

async function main() {
  const requestedOnly = process.argv.includes('--if-requested');
  const pool = createPool();
  const client = await pool.connect();
  let locked = false;
  let started = false;
  let transaction = false;
  const stats = {
    requestedOnly,
    refreshedToken: false,
    xeroItems: 0,
    targetProducts: 0,
    matched: 0,
    tracked: 0,
    untracked: 0,
    missing: 0,
    updated: 0,
  };

  try {
    await ensureSyncState(client);
    const lock = await client.query('SELECT pg_try_advisory_lock(742033) AS locked');
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) {
      console.log('Another Xero local-stock sync is already running.');
      return;
    }
    // Keep PostgreSQL precision for compare-and-clear; a newer catalogue action
    // must not be lost while this import is reading its saved Hub snapshot.
    const state = await client.query('SELECT refresh_requested_at::text AS refresh_requested_at FROM xero_stock_sync_state WHERE id = true');
    const requestedAt = state.rows[0]?.refresh_requested_at || null;
    if (requestedOnly && !state.rows[0]?.refresh_requested_at) {
      console.log('No invoice-triggered local-stock refresh is pending.');
      return;
    }
    await startDataSync(client, 'thanda');
    started = true;
    await client.query('UPDATE xero_stock_sync_state SET last_started_at=NOW(), updated_at=NOW() WHERE id=true');
    const token = await hubStatus();
    const fetched = await fetchXeroItems(client, token);
    const xeroItems = fetched.items;
    stats.xeroItems = xeroItems.length;
    const xeroItemsBySku = new Map();
    const xeroItemsById = new Map();
    for (const item of xeroItems) {
      if (item.ItemID) xeroItemsById.set(item.ItemID, item);
      const sku = normalizeSku(item.Code);
      if (sku) xeroItemsBySku.set(sku, item);
    }

    await ensureProductSchema(client);
    await client.query('BEGIN');
    transaction = true;
    // Publish inventory scope and product quantities from the same complete
    // saved collection. No new Hub or provider request is introduced.
    await saveInventoryEvidence(client, xeroItems, fetched);
    const products = await targetProducts(client);
    stats.targetProducts = products.length;

    for (const product of products) {
      const xeroItem = matchingXeroItem(product, xeroItemsBySku, xeroItemsById);
      if (!xeroItem) {
        stats.missing += 1;
        await updateLocalStock(client, product, null, null, fetched.observedAt);
        stats.updated += 1;
        continue;
      }

      stats.matched += 1;
      if (xeroItem.IsTrackedAsInventory === true) {
        stats.tracked += 1;
      } else {
        stats.untracked += 1;
      }

      await updateLocalStock(client, product, quantityOnHand(xeroItem), xeroItem, fetched.observedAt);
      stats.updated += 1;
    }
    await client.query(`UPDATE xero_stock_sync_state SET refresh_requested_at = CASE
      WHEN refresh_requested_at IS NOT DISTINCT FROM $1::timestamptz
        AND ($1::timestamptz IS NULL OR $2::timestamptz >= $1::timestamptz)
      THEN NULL ELSE refresh_requested_at END,
      last_completed_at = NOW(), updated_at = NOW() WHERE id = true`, [requestedAt, fetched.observedAt]);
    await finishDataSync(client, 'thanda', { observedAt: fetched.observedAt, counts: stats });
    await client.query('COMMIT');
    transaction = false;
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    if (started) await finishDataSync(client, 'thanda', { status: 'failed', error }).catch(() => {});
    throw error;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(742033)');
    client.release();
    await pool.end();
  }

  console.log(JSON.stringify(stats, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
