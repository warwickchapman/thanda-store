#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import { createPool, ensureProductSchema } from './product-sync-lib.mjs';

const TOKEN_URL = 'https://identity.xero.com/connect/token';
const ITEMS_URL = 'https://api.xero.com/api.xro/2.0/Items';
const DEFAULT_TOKEN_FILE = '/var/lib/thanda-store/xero-token.json';

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

async function fetchXeroItems(token) {
  if (!token.tenant_id) throw new Error('Xero token file does not contain tenant_id');

  const response = await fetch(ITEMS_URL, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'xero-tenant-id': token.tenant_id,
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

  const items = Array.isArray(payload.Items) ? payload.Items : [];
  console.error(`Fetched Xero Items: ${items.length}`);
  return items;
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
  const config = xeroConfig();
  let token = await readToken(config.tokenFile);
  const refreshResult = await refreshTokenIfNeeded(config, token);
  token = refreshResult.token;

  const xeroItems = await fetchXeroItems(token);
  const xeroItemsBySku = new Map();
  for (const item of xeroItems) {
    const sku = normalizeSku(item.Code);
    if (sku) xeroItemsBySku.set(sku, item);
  }

  const pool = createPool();
  const client = await pool.connect();
  const stats = {
    refreshedToken: refreshResult.refreshed,
    xeroItems: xeroItems.length,
    targetProducts: 0,
    matched: 0,
    tracked: 0,
    untracked: 0,
    missing: 0,
    updated: 0,
  };

  try {
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
  } finally {
    client.release();
    await pool.end();
  }

  console.log(JSON.stringify(stats, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
