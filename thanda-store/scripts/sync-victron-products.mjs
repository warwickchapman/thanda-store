#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPool,
  ensureProductSchema,
  normalizeText,
  numberOrNull,
  upsertProduct,
} from './product-sync-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_ROOT = process.env.VICTRON_EORDER_API_ROOT || 'https://eorder.victronenergy.com/api/v1';
const API_KEY = process.env.VICTRON_EORDER_API_KEY;
const REQUEST_TIMEOUT_MS = Number(process.env.VICTRON_REQUEST_TIMEOUT_MS || 20000);
const PAGE_SIZE = Number(process.env.VICTRON_PAGE_SIZE || 250);
const THANDA_DISCOUNT_FACTOR = Number(process.env.VICTRON_THANDA_DISCOUNT_FACTOR || 0.525);
const EXTENDED_REQUEST_DELAY_MS = Number(process.env.VICTRON_EXTENDED_REQUEST_DELAY_MS || 500);
const FETCH_EXTENDED = process.env.VICTRON_SYNC_EXTENDED === '1';
const ALLOWLIST_FILE = process.env.VICTRON_ALLOWLIST_FILE
  || path.resolve(__dirname, '../data/victron-zar-2026-q3-skus.json');
const RATE_LIMIT_CACHE_FILE = process.env.VICTRON_RATE_LIMIT_CACHE_FILE
  || path.resolve(__dirname, '../../.victron-rate-limit.json');

if (!API_KEY) {
  console.error('VICTRON_EORDER_API_KEY is required.');
  process.exit(1);
}

const pool = createPool();

function readRateLimitCache() {
  try {
    return JSON.parse(fs.readFileSync(RATE_LIMIT_CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeRateLimitCache(retryAfterSeconds) {
  const retryUntil = new Date(Date.now() + retryAfterSeconds * 1000).toISOString();
  fs.mkdirSync(path.dirname(RATE_LIMIT_CACHE_FILE), { recursive: true });
  fs.writeFileSync(RATE_LIMIT_CACHE_FILE, `${JSON.stringify({ retryUntil }, null, 2)}\n`, { mode: 0o600 });
  return retryUntil;
}

function skipIfRateLimited() {
  const cache = readRateLimitCache();
  const retryUntilMs = Date.parse(cache?.retryUntil || '');
  if (!Number.isFinite(retryUntilMs) || retryUntilMs <= Date.now()) return false;
  console.log(JSON.stringify({
    supplier: 'victron',
    skipped: true,
    reason: 'rate_limited',
    retryUntil: new Date(retryUntilMs).toISOString(),
  }, null, 2));
  return true;
}

function loadAllowedSkus() {
  const data = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, 'utf8'));
  return new Set((data.skus || []).map((sku) => String(sku).trim().toUpperCase()).filter(Boolean));
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: API_KEY,
        Accept: 'application/json',
        'User-Agent': 'ThandaStoreSync/1.0',
      },
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after');
      if (response.status === 429 && retryAfter) writeRateLimitCache(Number(retryAfter));
      const retryMessage = retryAfter ? ` retry after ${retryAfter}s` : '';
      const message = body?.detail || body?.message || text.slice(0, 200);
      throw new Error(`Victron HTTP ${response.status}:${retryMessage} ${message}`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPagedProducts(endpoint, pageSize = PAGE_SIZE) {
  const products = [];
  let url = `${API_ROOT.replace(/\/$/, '')}/${endpoint}/?format=json&limit=${pageSize}`;
  while (url) {
    const page = await fetchJson(url);
    const rows = Array.isArray(page) ? page : page.results || [];
    products.push(...rows);
    url = Array.isArray(page) ? '' : page.next;
  }
  return products;
}

async function fetchExtendedProduct(sku) {
  return fetchJson(`${API_ROOT.replace(/\/$/, '')}/products-extended/${encodeURIComponent(sku)}/?format=json`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectWarehouseStock(product) {
  const warehouseStock = numberOrNull(product.all_stock_by_warehouse?.af_sa_inzuzo);
  if (warehouseStock !== null) return warehouseStock;
  return numberOrNull(product.stock_quantity) ?? 0;
}

function selectImageUrl(product) {
  const productData = product.product_data || {};
  const mainImage = productData.main_images?.[0]?.url;
  return normalizeText(mainImage || productData.image || '');
}

function buildProduct(product, extendedProduct) {
  const richProduct = extendedProduct || product;
  const productData = richProduct.product_data || {};
  const accountPrice = numberOrNull(product.price) ?? 0;
  const apiRecommendedRetailExVat = numberOrNull(product.enduser_price_zar?.price);
  const recommendedRetailExVat = THANDA_DISCOUNT_FACTOR > 0
    ? Math.round((accountPrice / THANDA_DISCOUNT_FACTOR) * 100) / 100
    : apiRecommendedRetailExVat;
  const category = normalizeText(product.category || product.subcategory || productData.category, 'uncategorized');
  const name = normalizeText(product.description || productData.name, product.sku);
  const imageUrl = selectImageUrl(richProduct);
  const is120vAc = /(^|[^0-9])120V([^0-9]|$)/i.test(name);
  const hidden = category.toLowerCase() === 'solar home system';
  const supplierStock = selectWarehouseStock(product);
  const details = {
    originalPrice: recommendedRetailExVat,
    recommendedRetailExVat,
    recommendedRetailPriceVatMode: 'ex_vat',
    recommendedRetailSource: 'eorder_price_divided_by_thanda_discount_factor',
    apiRecommendedRetailExVat,
    thandaDiscountFactor: THANDA_DISCOUNT_FACTOR,
    thandaDiscountPercent: Math.round((1 - THANDA_DISCOUNT_FACTOR) * 10000) / 100,
    distributorPriceExVat: accountPrice,
    currency: product.currency || 'ZAR',
    gtin13: product.gtin13 || null,
    replacementSku: product.replacement_sku || null,
    subcategory: product.subcategory || null,
    categoryId: product.category_id || null,
    subcategoryId: product.subcategory_id || null,
    allStockByWarehouse: product.all_stock_by_warehouse || null,
    additionalStockQuantity: numberOrNull(product.additional_stock_quantity),
    priceBreakQty: numberOrNull(product.price_break_qty),
    priceBreakPrice: numberOrNull(product.price_break_price),
    minimumOrderQuantity: numberOrNull(product.minimum_order_quantity),
    productUrl: `https://eorder.victronenergy.com/api/v1/products/${encodeURIComponent(product.sku)}/`,
    hidden,
    is120vAc,
    productNotes: is120vAc ? ['Note: 120V AC'] : [],
    supplierStockLabel: 'Victron Warehouse ZA',
    // E-Order exposes current warehouse quantities but does not expose a
    // reliable inbound shipment/ETA field in the product response. Never
    // promise the normal lead time when South African stock is zero.
    supplierAvailability: supplierStock > 0 ? 'Availability: 3-5 working days' : 'Out of stock / not available',
  };

  if (extendedProduct) {
    details.imageSource = imageUrl ? 'victron-products-extended' : null;
    details.documents = productData.documents || [];
    details.technicalData = productData.pms_technical_data || [];
  }

  return {
    sku: normalizeText(product.sku).toUpperCase(),
    supplier: 'victron',
    supplier_item_id: normalizeText(product.sku).toUpperCase(),
    name,
    category,
    price: accountPrice,
    image_url: imageUrl,
    stock_on_hand: supplierStock,
    details,
  };
}

async function main() {
  if (skipIfRateLimited()) return;

  const allowedSkus = loadAllowedSkus();
  const products = await fetchPagedProducts('products');
  const allowedProducts = products.filter((product) => allowedSkus.has(String(product.sku || '').toUpperCase()));
  const extendedBySku = new Map();
  const extendedFailures = [];

  if (FETCH_EXTENDED) {
    for (const product of allowedProducts) {
      const sku = String(product.sku || '').toUpperCase();
      try {
        extendedBySku.set(sku, await fetchExtendedProduct(sku));
      } catch (error) {
        extendedFailures.push({ sku, error: error.message });
        if (String(error.message).includes('Victron HTTP 429')) break;
      }
      if (EXTENDED_REQUEST_DELAY_MS > 0) await sleep(EXTENDED_REQUEST_DELAY_MS);
    }
  }

  const client = await pool.connect();
  const stats = {
    allowed: allowedSkus.size,
    apiProducts: products.length,
    matched: allowedProducts.length,
    synced: 0,
    missingFromApi: [],
    missingImagesAfterExtended: [],
    failed: [],
    extendedFailures,
    extended: FETCH_EXTENDED,
  };

  try {
    await ensureProductSchema(client);
    const matchedSkus = new Set(allowedProducts.map((product) => String(product.sku || '').toUpperCase()));
    stats.missingFromApi = [...allowedSkus].filter((sku) => !matchedSkus.has(sku)).sort();

    for (const product of allowedProducts) {
      const sku = String(product.sku || '').toUpperCase();
      try {
        const normalized = buildProduct(product, extendedBySku.get(sku));
        await upsertProduct(client, normalized);
        stats.synced += 1;
        if (FETCH_EXTENDED && !normalized.image_url) stats.missingImagesAfterExtended.push(sku);
      } catch (error) {
        stats.failed.push({ sku, error: error.message });
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log(JSON.stringify(stats, null, 2));
  if (stats.failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
