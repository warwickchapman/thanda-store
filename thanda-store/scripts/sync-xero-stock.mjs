#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import { createPool, ensureProductSchema } from './product-sync-lib.mjs';

const TOKEN_URL = 'https://identity.xero.com/connect/token';
const ITEMS_URL = 'https://api.xero.com/api.xro/2.0/Items';
const DEFAULT_TOKEN_FILE = '/var/lib/thanda-store/xero-token.json';
const DAILY_API_RESERVE = 150;

function headerNumber(headers, name) {
  const value = Number(headers.get(name));
  return Number.isFinite(value) ? value : null;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function xeroConfig() {
  return {
    clientId: requiredEnv('XERO_CLIENT_ID'),
    clientSecret: requiredEnv('XERO_CLIENT_SECRET'),
    tokenFile: process.env.XERO_TOKEN_FILE || DEFAULT_TOKEN_FILE,
  };
}

function normalizeSku(value) {
  return String(value || '').trim().toUpperCase();
}

function quantityOnHand(item) {
  if (!item || item.IsTrackedAsInventory !== true) return 0;
  const quantity = Number(item.QuantityOnHand);
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  return Math.floor(quantity);
}

function moneyOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 100) / 100;
}

async function readToken(tokenFile) {
  const raw = await fs.readFile(tokenFile, 'utf8');
  return JSON.parse(raw);
}

async function writeToken(tokenFile, token) {
  await fs.mkdir(path.dirname(tokenFile), { recursive: true });
  await fs.writeFile(tokenFile, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
}

async function refreshTokenIfNeeded(config, token) {
  const expiresAt = token.expires_at ? Date.parse(token.expires_at) : 0;
  if (token.access_token && expiresAt > Date.now() + 60_000) {
    return { token, refreshed: false };
  }

  if (!token.refresh_token) {
    throw new Error('Xero token file does not contain a refresh_token');
  }

  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Xero token refresh failed: ${response.status} ${payload.error || ''}`.trim());
  }

  const updated = {
    ...token,
    ...payload,
    expires_at: new Date(Date.now() + Number(payload.expires_in || 0) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };

  await writeToken(config.tokenFile, updated);
  return { token: updated, refreshed: true };
}

async function fetchXeroItems(client, token) {
  if (!token.tenant_id) throw new Error('Xero token file does not contain tenant_id');

  const response = await fetch(ITEMS_URL, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'xero-tenant-id': token.tenant_id,
      Accept: 'application/json',
    },
  });

  const responseText = await response.text();
  await recordUsage(client, response);
  let payload = {};
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new Error(`Xero Items returned non-JSON: ${response.status} ${response.statusText}`);
  }
  if (!response.ok) {
    throw new Error(`Xero Items fetch failed: ${response.status} ${response.statusText}`);
  }

  const items = Array.isArray(payload.Items) ? payload.Items : [];
  console.error(`Fetched Xero Items: ${items.length}`);
  return { items };
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

async function recordUsage(client, response) {
  const rateLimitProblem = response.headers.get('x-rate-limit-problem');
  const retryAfter = headerNumber(response.headers, 'retry-after');
  await client.query(`
    INSERT INTO xero_api_usage (id, day_limit_remaining, minute_limit_remaining, app_minute_limit_remaining, rate_limit_problem, retry_after_seconds, next_allowed_at, source, observed_at)
    VALUES (true, $1, $2, $3, $4, $5, $6, 'stock-sync', NOW())
    ON CONFLICT (id) DO UPDATE SET
      day_limit_remaining = EXCLUDED.day_limit_remaining,
      minute_limit_remaining = EXCLUDED.minute_limit_remaining,
      app_minute_limit_remaining = EXCLUDED.app_minute_limit_remaining,
      rate_limit_problem = EXCLUDED.rate_limit_problem,
      retry_after_seconds = EXCLUDED.retry_after_seconds,
      next_allowed_at = EXCLUDED.next_allowed_at,
      source = EXCLUDED.source,
      observed_at = EXCLUDED.observed_at
  `, [
    headerNumber(response.headers, 'x-daylimit-remaining'),
    headerNumber(response.headers, 'x-minlimit-remaining'),
    headerNumber(response.headers, 'x-appminlimit-remaining'),
    rateLimitProblem,
    retryAfter,
    rateLimitProblem === 'day' && retryAfter ? new Date(Date.now() + retryAfter * 1_000).toISOString() : null,
  ]);
}

async function targetProducts(client) {
  const result = await client.query(`
    SELECT supplier, sku
    FROM products
    WHERE supplier = 'victron'
       OR (supplier = 'lora' AND sku = 'LORA-RS-00120')
    ORDER BY supplier, sku
  `);
  return result.rows;
}

async function updateLocalStock(client, product, localStock, xeroItem) {
  const xeroSalesPrice = moneyOrNull(xeroItem?.SalesDetails?.UnitPrice);
  const xeroPurchasePrice = moneyOrNull(xeroItem?.PurchaseDetails?.UnitPrice);
  const shouldSyncXeroPrice = product.supplier === 'lora';

  await client.query(
    `
      UPDATE products
      SET name = CASE
            WHEN $5::boolean AND NULLIF($6::text, '') IS NOT NULL THEN $6::text
            ELSE name
          END,
          price = CASE
            WHEN $5::boolean AND $7::numeric IS NOT NULL THEN $7::numeric::text
            ELSE price
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
                to_jsonb($3::int),
                true
              ),
              '{xeroStockSyncedAt}',
              to_jsonb(to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
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
    ],
  );
}

async function main() {
  const requestedOnly = process.argv.includes('--if-requested');
  const config = xeroConfig();
  const pool = createPool();
  const client = await pool.connect();
  let locked = false;
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
    const state = await client.query('SELECT refresh_requested_at FROM xero_stock_sync_state WHERE id = true');
    if (requestedOnly && !state.rows[0]?.refresh_requested_at) {
      console.log('No invoice-triggered local-stock refresh is pending.');
      return;
    }
    const allowance = await client.query('SELECT day_limit_remaining, next_allowed_at FROM xero_api_usage WHERE id = true');
    const nextAllowedAt = Date.parse(allowance.rows[0]?.next_allowed_at || '');
    if (Number.isFinite(nextAllowedAt) && nextAllowedAt > Date.now()) {
      console.log(`Xero local-stock sync paused until ${new Date(nextAllowedAt).toISOString()} after a daily rate limit response.`);
      return;
    }
    const dayLimitRemaining = Number(allowance.rows[0]?.day_limit_remaining);
    if (Number.isFinite(dayLimitRemaining) && dayLimitRemaining <= DAILY_API_RESERVE) {
      console.log(`Xero local-stock sync paused to retain the ${DAILY_API_RESERVE}-call daily reserve.`);
      return;
    }

    await client.query('UPDATE xero_stock_sync_state SET last_started_at = NOW(), updated_at = NOW() WHERE id = true');
    let token = await readToken(config.tokenFile);
    const refreshResult = await refreshTokenIfNeeded(config, token);
    token = refreshResult.token;
    stats.refreshedToken = refreshResult.refreshed;
    const fetched = await fetchXeroItems(client, token);
    const xeroItems = fetched.items;
    stats.xeroItems = xeroItems.length;
    const xeroItemsBySku = new Map();
    for (const item of xeroItems) {
      const sku = normalizeSku(item.Code);
      if (sku) xeroItemsBySku.set(sku, item);
    }

    await ensureProductSchema(client);
    const products = await targetProducts(client);
    stats.targetProducts = products.length;

    for (const product of products) {
      const xeroItem = xeroItemsBySku.get(normalizeSku(product.sku));
      if (!xeroItem) {
        stats.missing += 1;
        await updateLocalStock(client, product, 0, null);
        stats.updated += 1;
        continue;
      }

      stats.matched += 1;
      if (xeroItem.IsTrackedAsInventory === true) {
        stats.tracked += 1;
      } else {
        stats.untracked += 1;
      }

      await updateLocalStock(client, product, quantityOnHand(xeroItem), xeroItem);
      stats.updated += 1;
    }
    await client.query('UPDATE xero_stock_sync_state SET refresh_requested_at = NULL, last_completed_at = NOW(), updated_at = NOW() WHERE id = true');
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
