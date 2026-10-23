import { exclusion } from './victron-catalogue-review.mjs';
import { prices } from './victron-pricing.mjs';
import { stockSku } from './victron-sku-family.mjs';
import { existingStoreProduct } from './admin/store-products.mjs';

const code = value => String(value || '').trim().toUpperCase();

// Quarterly PDFs are verification evidence only. New Store listings require
// an approved inventory definition; existing listings always receive updates.
export function selectVictronSyncProducts(catalogue, { existing = [], otherProducts = [], inventory, run, decisions = [], now = Date.now() } = {}) {
  const existingCodes = new Set(existing.map(row => code(row.sku)));
  const existingArticles = new Set([...existingCodes].map(stockSku));
  const observed = Date.parse(inventory?.observed_at);
  const successful = Date.parse(run?.last_successful_at);
  const age = Number(new Date(now)) - observed;
  const validItems = Array.isArray(inventory?.items) && inventory.items.every(item => typeof item?.Code === 'string' && item.Code.trim() && typeof item.ItemID === 'string' && item.ItemID.trim());
  const inventoryReady = inventory?.company === 'thanda-solar' && typeof inventory.snapshot === 'string' && Boolean(inventory.snapshot.trim())
    && validItems && new Set(inventory.items.map(item => code(item.Code))).size === inventory.items.length
    && Number.isFinite(age) && age >= -300_000 && age <= 120 * 60_000
    && Number.isFinite(successful) && successful <= Number(new Date(now)) + 300_000
    && ['success', 'running'].includes(run?.last_status) && !run?.last_error;
  const tracked = new Map((inventoryReady ? inventory.items : []).filter(item => item.IsTrackedAsInventory === true).map(item => [code(item.Code), item]));
  const approvals = new Map(decisions.filter(row => row.company === 'thanda-solar').map(row => [code(row.sku), row.approvedReason]));
  const selected = catalogue.filter(row => existingCodes.has(code(row.sku)));
  const added = [];
  const skipped = [];
  // Base and R are one inventory article. Prefer the base when both approved
  // variants are new; do not silently change an existing literal Store SKU.
  for (const row of [...catalogue].sort((a, b) => Number(code(a.sku).endsWith('R')) - Number(code(b.sku).endsWith('R')) || code(a.sku).localeCompare(code(b.sku)))) {
    const sku = code(row.sku);
    if (existingCodes.has(sku)) continue;
    const advice = exclusion(row);
    const reason = !inventoryReady ? 'Saved Thanda inventory is unavailable, overdue or incomplete.'
      : !tracked.has(sku) ? 'Awaiting a tracked Thanda Xero inventory definition.'
      : existingStoreProduct(tracked.get(sku), otherProducts) ? 'This Xero item already has a Store listing.'
      : /^(SPM|SPP)/.test(sku) ? advice
      : advice && approvals.get(sku) !== advice ? advice
      : prices(row).error || (existingArticles.has(stockSku(sku)) ? 'Retail packaging is already listed.' : null)
        || (/available\s+until\s+stock\s+0|\bif\s+0\s*,?\s*order\s+[A-Z0-9-]+/i.test(row.description || '') ? 'Phase-out article requires an existing Store listing.' : null);
    if (reason) { skipped.push({ sku, reason }); continue; }
    selected.push(row);
    added.push(sku);
    existingArticles.add(stockSku(sku));
  }
  const present = new Set(catalogue.map(row => code(row.sku)));
  return { products: selected.sort((a, b) => code(a.sku).localeCompare(code(b.sku))), added, skipped,
    inventoryReady, discoveryDeferred: inventoryReady ? null : 'New Store listings await complete, current saved Thanda inventory.',
    absentExisting: existing.filter(row => !present.has(code(row.sku))).map(row => code(row.sku)).sort() };
}

export async function loadVictronSyncContext(db) {
  // Share onboarding's lock so approved discovery cannot race a manual import.
  await db.query('SELECT pg_advisory_xact_lock(742041)');
  const existing = (await db.query("SELECT id,supplier,sku,supplier_item_id,name,category,price,image_url,stock_on_hand,details FROM products WHERE supplier='victron' ORDER BY sku FOR UPDATE")).rows;
  const otherProducts = (await db.query("SELECT supplier,sku,details FROM products WHERE supplier<>'victron'")).rows;
  let inventory = null;
  let run = null;
  // The stock importer owns this table. Missing optional evidence must not
  // abort the catalogue transaction on a new installation.
  const installed = (await db.query("SELECT to_regclass('thanda_inventory_evidence') AS name")).rows[0]?.name;
  if (installed) inventory = (await db.query('SELECT company,observed_at,snapshot,items FROM thanda_inventory_evidence WHERE id=true')).rows[0] || null;
  run = (await db.query("SELECT last_status,last_error,last_successful_at FROM data_sync_status WHERE source_id='thanda'")).rows[0] || null;
  return { existing, otherProducts, inventory, run };
}
