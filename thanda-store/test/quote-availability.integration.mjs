// Synthetic PostgreSQL evidence only: no providers, live quotes or email writes.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { quoteLineItems } from '../src/lib/commerce/quote-line.mjs';
import { chooseFulfilmentProduct, loadSkuSuccessions } from '../src/lib/sku-successions.mjs';

if (process.env.RUN_QUOTE_AVAILABILITY_DB_TESTS !== '1') {
  throw new Error('Set RUN_QUOTE_AVAILABILITY_DB_TESTS=1 to run against a disposable local quote_availability_test database.');
}
const databaseUrl = new URL(process.env.DATABASE_URL || '');
if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)
  || !['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname)
  || decodeURIComponent(databaseUrl.pathname) !== '/quote_availability_test'
  || databaseUrl.search || databaseUrl.hash) {
  throw new Error('Quote availability integration tests require a loopback DATABASE_URL for quote_availability_test, without connection overrides.');
}

const now = new Date('2026-10-26T10:00:00Z');
const recent = '2026-10-26T09:55:00.000Z';
const predecessorSku = 'PMP482305010';
const successorSku = 'PMP482305012';
const schema = `quote_availability_test_${crypto.randomBytes(8).toString('hex')}`;
const admin = new pg.Pool({ connectionString: databaseUrl.href, connectionTimeoutMillis: 5_000 });
let pool;
let schemaCreated = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Provider access is forbidden in quote availability integration tests.'); };

try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  pool = new pg.Pool({ connectionString: databaseUrl.href, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5_000 });
  // The queried columns retain their production types, including BIGSERIAL ids,
  // DATE plans, JSONB stock observations and the actual reservation joins.
  await pool.query(`
    CREATE TABLE products (
      id BIGSERIAL PRIMARY KEY, sku TEXT NOT NULL, supplier TEXT NOT NULL,
      name TEXT NOT NULL, stock_on_hand INTEGER NOT NULL DEFAULT 0,
      details JSONB NOT NULL DEFAULT '{}'::jsonb, UNIQUE (supplier, sku)
    );
    CREATE TABLE victron_sku_successions (
      predecessor_sku TEXT PRIMARY KEY, successor_sku TEXT NOT NULL,
      source_description TEXT NOT NULL, CHECK (predecessor_sku <> successor_sku)
    );
    CREATE TABLE renogy_sku_successions (
      predecessor_sku TEXT PRIMARY KEY, successor_sku TEXT NOT NULL,
      source_description TEXT NOT NULL, CHECK (predecessor_sku <> successor_sku)
    );
    CREATE TABLE data_sync_status (
      source_id TEXT PRIMARY KEY, last_status TEXT, source_observed_at TIMESTAMPTZ,
      last_successful_at TIMESTAMPTZ, last_error TEXT
    );
    CREATE TABLE thanda_inventory_evidence (
      id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
      company TEXT NOT NULL CHECK (company = 'thanda-solar'),
      observed_at TIMESTAMPTZ NOT NULL, snapshot TEXT NOT NULL, items JSONB NOT NULL
    );
    CREATE TABLE victron_order_sync_state (
      id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id), last_started_at TIMESTAMPTZ,
      last_completed_at TIMESTAMPTZ, last_successful_sync_at TIMESTAMPTZ, last_error TEXT
    );
    CREATE TABLE xero_accepted_quotes (
      quote_id TEXT PRIMARY KEY, quote_number TEXT NOT NULL,
      reservation_eligible BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE xero_accepted_quote_lines (
      quote_id TEXT NOT NULL REFERENCES xero_accepted_quotes(quote_id) ON DELETE CASCADE,
      line_key TEXT NOT NULL, sku TEXT NOT NULL, quantity INTEGER NOT NULL CHECK (quantity > 0),
      PRIMARY KEY (quote_id, line_key)
    );
    CREATE TABLE supplier_inbound_orders (
      id BIGSERIAL PRIMARY KEY, supplier TEXT NOT NULL CHECK (supplier = 'victron'),
      supplier_order_number TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'inbound',
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'received')),
      UNIQUE (supplier, supplier_order_number)
    );
    CREATE TABLE supplier_inbound_order_lines (
      id BIGSERIAL PRIMARY KEY,
      inbound_order_id BIGINT NOT NULL REFERENCES supplier_inbound_orders(id) ON DELETE CASCADE,
      sku TEXT NOT NULL, description TEXT NOT NULL,
      ordered_quantity INTEGER NOT NULL CHECK (ordered_quantity > 0),
      received_quantity INTEGER NOT NULL DEFAULT 0 CHECK (received_quantity >= 0 AND received_quantity <= ordered_quantity),
      is_stock_item BOOLEAN NOT NULL DEFAULT true, UNIQUE (inbound_order_id, sku)
    );
    CREATE TABLE victron_provisional_backorders (
      order_number TEXT PRIMARY KEY, reference TEXT
    );
    CREATE TABLE victron_provisional_backorder_order_lines (
      order_number TEXT NOT NULL REFERENCES victron_provisional_backorders(order_number) ON DELETE CASCADE,
      sku TEXT NOT NULL, description TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0), planned_for DATE,
      PRIMARY KEY (order_number, sku)
    );
    CREATE TABLE victron_backorder_ignored_lines (
      order_number TEXT NOT NULL, sku TEXT NOT NULL, PRIMARY KEY (order_number, sku)
    );
  `);
  await pool.query(`INSERT INTO victron_sku_successions VALUES ($1, $2, 'If 0, order successor')`, [predecessorSku, successorSku]);
  const readOnlyDb = { query: (sql, values) => {
    assert.match(sql.trim(), /^SELECT\b/, 'Quote creation must only read cached evidence.');
    return pool.query(sql, values);
  } };
  const freshDetails = (local = 0, patch = {}) => ({
    localStockOnHand: local, xeroStockStatus: 'tracked', xeroStockSyncedAt: recent,
    supplierStockStatus: 'known', supplierObservedAt: recent, cataloguePresent: true,
    supplierCostExVat: 123.45, privateSupplierAccount: 'synthetic-private-account', ...patch,
  });
  async function addProduct(supplier, sku, local = 0, stock = 0, patch = {}) {
    return (await pool.query(`INSERT INTO products (supplier, sku, name, stock_on_hand, details)
      VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
    [supplier, sku, `Xero description for ${sku}`, stock, JSON.stringify(freshDetails(local, patch))])).rows[0];
  }
  const publicProduct = raw => ({
    id: Number(raw.id), sku: raw.sku, supplier: raw.supplier, name: raw.name,
    recommended_retail_ex_vat: 1_000, b2b_discount_percent: 30,
    details: { xeroStockStatus: raw.details.xeroStockStatus },
  });
  const selection = (raw, quantity = 1) => ({ product: publicProduct(raw), quantity });
  async function availability(raw, quantity = 1) {
    const [line] = await quoteLineItems(readOnlyDb, [selection(raw, quantity)], now);
    assert.deepEqual(Object.keys(line).sort(), ['Description', 'DiscountRate', 'ItemCode', 'Quantity', 'TaxType', 'UnitAmount']);
    assert.equal(line.ItemCode, raw.sku);
    assert.equal(line.Quantity, quantity);
    assert.equal(line.UnitAmount, 1_000);
    assert.equal(line.DiscountRate, 30);
    assert.equal(line.TaxType, 'OUTPUT3');
    assert.ok(!JSON.stringify(line).includes('synthetic-private-account'));
    assert.ok(!JSON.stringify(line).includes('supplierCostExVat'));
    assert.ok(line.Description.startsWith(`${raw.name}\n\n`));
    return line.Description.slice(raw.name.length + 2);
  }
  async function resetEvidence() {
    await pool.query(`TRUNCATE xero_accepted_quote_lines, xero_accepted_quotes,
      supplier_inbound_order_lines, supplier_inbound_orders,
      victron_provisional_backorder_order_lines, victron_provisional_backorders,
      victron_backorder_ignored_lines, data_sync_status, victron_order_sync_state`);
    await pool.query(`INSERT INTO data_sync_status VALUES ('accepted-quotes', 'success', $1, $1, NULL)`, [recent]);
    await pool.query(`INSERT INTO victron_order_sync_state VALUES (true, $1::timestamptz - INTERVAL '1 minute', $1, $1, NULL)`, [recent]);
  }
  async function addBackorder(order, sku, quantity, date, reference = null) {
    await pool.query(`INSERT INTO victron_provisional_backorders VALUES ($1, $2)
      ON CONFLICT (order_number) DO NOTHING`, [order, reference]);
    await pool.query(`INSERT INTO victron_provisional_backorder_order_lines
      VALUES ($1, $2, 'Synthetic planned article', $3, $4::date)`, [order, sku, quantity, date]);
  }
  async function reserve(sku, eligible = true) {
    const id = crypto.randomUUID();
    await pool.query('INSERT INTO xero_accepted_quotes VALUES ($1, $1, $2)', [id, eligible]);
    await pool.query(`INSERT INTO xero_accepted_quote_lines VALUES ($1, '1', $2, 1)`, [id, sku]);
  }
  const enquiry = 'Stock availability on enquiry.';
  const inStock = 'Stock available. Subject to prior sale.';
  const partial = quantity => `x${quantity} available in stock. Subject to prior sale.\n`;
  const lead = (days, balance = false) => `Estimated lead time${balance ? ' for the balance' : ''}: ${days} working days, subject to confirmation.`;
  const planned = (date, balance = false) => `Estimated lead time${balance ? ' for the balance' : ''}: around ${date}, plus 5-7 working days. Subject to supplier confirmation; timing may change.`;

  await resetEvidence();
  const owned = await addProduct('hubble', 'LOCAL-FULL', 4);
  assert.equal(typeof owned.id, 'string', 'BIGSERIAL raw ids must be mapped to numeric selected ids.');
  assert.equal(await availability(owned, 4), inStock);
  const renogy = await addProduct('renogy', 'RENOGY-AVAILABLE', 0, 3);
  assert.equal(await availability(renogy, 3), lead('2-4'));
  const renogyPartial = await addProduct('renogy', 'RENOGY-PARTIAL', 1, 2);
  assert.equal(await availability(renogyPartial, 3), partial(1) + lead('2-4', true));
  const victronWarehouse = await addProduct('victron', 'SCC125110412', 0, 3);
  assert.equal(await availability(victronWarehouse, 3), lead('5-7'));
  const victronPartial = await addProduct('victron', 'SCC125110411', 1, 2);
  assert.equal(await availability(victronPartial, 3), partial(1) + lead('5-7', true));
  const unknown = await addProduct('renogy', 'RENOGY-UNKNOWN', 100, 100,
    { xeroStockSyncedAt: null, supplierObservedAt: null });
  assert.equal(await availability(unknown, 3), enquiry);

  const successor = await addProduct('victron', successorSku);
  await addBackorder('SO-FIRST', successorSku, 1, '2026-11-02');
  await addBackorder('SO-SECOND', `${successorSku}R`, 2, '2026-11-20');
  await addBackorder('SO-PAST', successorSku, 100, '2026-10-25');
  assert.equal(await availability(successor, 3), planned('20 November 2026'));
  assert.equal(await availability(successor, 4), enquiry, 'Dated supply must cover the whole requested balance.');

  // An accepted predecessor reservation consumes the same canonical family,
  // even when the selected successor has a later, apparently sufficient plan.
  await reserve(`${predecessorSku}R`, false);
  await reserve('BPP900400100');
  assert.equal(await availability(successor, 3), planned('20 November 2026'));
  await reserve(`${predecessorSku}R`);
  assert.equal(await availability(successor, 3), enquiry);

  await resetEvidence();
  await addBackorder('SO-IGNORED', successorSku, 100, '2026-11-01');
  await pool.query('INSERT INTO victron_backorder_ignored_lines VALUES ($1, $2)', ['SO-IGNORED', successorSku]);
  await addBackorder('SO-RMA', successorSku, 100, '2026-11-02', 'RMA replacement');
  await addBackorder('SO-INBOUND', successorSku, 100, '2026-11-03');
  const inbound = (await pool.query(`INSERT INTO supplier_inbound_orders
    (supplier, supplier_order_number) VALUES ('victron', 'SO-INBOUND') RETURNING id`)).rows[0];
  await pool.query(`INSERT INTO supplier_inbound_order_lines
    (inbound_order_id, sku, description, ordered_quantity, received_quantity)
    VALUES ($1, $2, 'Already inbound predecessor', 100, 1)`, [inbound.id, `${predecessorSku}R`]);
  await addBackorder('SO-VALID', successorSku, 3, '2026-11-20');
  assert.equal(await availability(successor, 3), planned('20 November 2026'),
    'Ignored, RMA and canonical-family inbound overlap must not establish an earlier estimate.');

  await pool.query(`UPDATE data_sync_status SET source_observed_at = $1,
    last_successful_at = $2`, ['2026-10-26T07:59:00Z', recent]);
  assert.equal(await availability(successor, 3), enquiry, 'A recent cache import cannot refresh an old source observation.');
  await pool.query(`UPDATE data_sync_status SET source_observed_at = $1,
    last_status = 'failed', last_error = 'Synthetic failure'`, [recent]);
  assert.equal(await availability(successor, 3), enquiry);
  await pool.query(`UPDATE data_sync_status SET last_status = 'success', last_error = NULL`);
  await pool.query(`UPDATE victron_order_sync_state SET last_error = 'Synthetic E-Order failure'`);
  assert.equal(await availability(successor, 3), enquiry);
  await pool.query(`UPDATE victron_order_sync_state SET last_error = NULL,
    last_started_at = $1::timestamptz + INTERVAL '1 minute'`, [recent]);
  assert.equal(await availability(successor, 3), enquiry, 'An in-progress E-Order run cannot establish reliable planned stock.');

  await resetEvidence();
  const predecessor = await addProduct('victron', predecessorSku, 1, 0, { hidden: true });
  await pool.query(`UPDATE products SET stock_on_hand = 100 WHERE id = $1`, [successor.id]);
  const visibleSuccessor = (await pool.query('SELECT * FROM products WHERE id = $1', [successor.id])).rows[0];
  const actual = chooseFulfilmentProduct(visibleSuccessor, [predecessor, visibleSuccessor],
    await loadSkuSuccessions(readOnlyDb), { allowHiddenFamilyStock: true });
  assert.equal(actual.sku, predecessorSku);
  await addBackorder('SO-SUCCESSOR-ONLY', successorSku, 100, '2026-11-02');
  assert.equal(await availability(actual, 3), partial(1) + 'Stock availability for the balance on enquiry.',
    'Visible successor stock and plans cannot promise the predecessor that is actually fulfilled.');
  await addBackorder('SO-ACTUAL-ARTICLE', `${predecessorSku}R`, 2, '2026-11-20');
  assert.equal(await availability(actual, 3), partial(1) + planned('20 November 2026', true));
  await assert.rejects(quoteLineItems(readOnlyDb,
    [{ product: { ...publicProduct(predecessor), sku: successorSku }, quantity: 1 }], now), /selected product has changed/);
  assert.deepEqual(await quoteLineItems(readOnlyDb, [], now), []);

  // Ordinary Renogy products have no Xero stock-import status. A complete saved
  // Items snapshot establishes their accounting identity independently of stock.
  const renogyIdentity = await addProduct('renogy', 'RBC50D1S-G2-SA', 0, 3,
    { xeroStockStatus: undefined, xeroStockSyncedAt: null, localStockOnHand: null });
  const renogySelections = [selection(renogyIdentity, 2)];
  const [withoutInventory] = await quoteLineItems(readOnlyDb, renogySelections, now);
  assert.equal(Object.hasOwn(renogyIdentity.details, 'xeroStockStatus'), false);
  assert.equal(Object.hasOwn(withoutInventory, 'ItemCode'), false, 'Missing evidence retains the legacy omission.');
  assert.deepEqual(withoutInventory, {
    Description: `${renogyIdentity.name}\n\n${lead('2-4')}`,
    Quantity: 2, UnitAmount: 1_000, DiscountRate: 30, TaxType: 'OUTPUT3',
  });
  const mappedItem = {
    Code: renogyIdentity.sku, ItemID: 'synthetic-renogy-item',
    Name: 'A different saved inventory name', IsTrackedAsInventory: true, QuantityOnHand: 100,
  };
  await pool.query(`INSERT INTO thanda_inventory_evidence
    VALUES (true, 'thanda-solar', $1, 'synthetic-complete-items', $2::jsonb)`, [recent, JSON.stringify([mappedItem])]);
  let inventoryReads = 0;
  const identityReadDb = { query: (sql, values) => {
    if (sql.includes('FROM thanda_inventory_evidence')) inventoryReads++;
    return readOnlyDb.query(sql, values);
  } };
  const [withInventory] = await quoteLineItems(identityReadDb, renogySelections, now);
  assert.equal(inventoryReads, 1, 'Item identities are resolved with one saved snapshot query.');
  assert.deepEqual(withInventory, { ItemCode: renogyIdentity.sku, ...withoutInventory },
    'Identity mapping changes only ItemCode, preserving the selected description, quantity, price, discount and VAT.');
  assert.deepEqual(renogySelections, [selection(renogyIdentity, 2)], 'Mapping must not mutate selected catalogue products.');
  await pool.query('UPDATE thanda_inventory_evidence SET observed_at = $1', ['2026-10-26T07:59:00Z']);
  assert.deepEqual((await quoteLineItems(readOnlyDb, renogySelections, now))[0], withoutInventory,
    'A stale snapshot cannot introduce an item identity and retains the legacy fallback.');

  // The raw store-managed ItemID is authoritative even though the public DTO
  // omits it. Reused codes and renamed original items must not change ownership.
  const managed = await addProduct('enertec', 'STORE-MANAGED-ITEM', 0, 0,
    { storeManaged: true, xeroItemId: 'synthetic-original-item' });
  const managedSelection = selection(managed);
  assert.equal(Object.hasOwn(managedSelection.product.details, 'xeroItemId'), false);
  const managedExpected = {
    Description: `${managed.name}\n\n${enquiry}`,
    Quantity: 1, UnitAmount: 1_000, DiscountRate: 30, TaxType: 'OUTPUT3',
  };
  await pool.query(`UPDATE thanda_inventory_evidence SET observed_at = $1, items = $2::jsonb`, [recent, JSON.stringify([
    mappedItem,
    { Code: managed.sku, ItemID: 'synthetic-new-owner' },
    { Code: 'RENAMED-ORIGINAL-ITEM', ItemID: 'synthetic-original-item' },
  ])]);
  inventoryReads = 0;
  const mappedBatch = await quoteLineItems(identityReadDb, [renogySelections[0], managedSelection], now);
  assert.equal(inventoryReads, 1, 'Multiple suppliers share one complete Items snapshot query.');
  assert.deepEqual(mappedBatch[0], withInventory);
  assert.deepEqual(mappedBatch[1], managedExpected,
    'Fresh reliable identity mismatch must withhold ItemCode despite legacy tracked stock status.');
  await pool.query('UPDATE thanda_inventory_evidence SET items = $1::jsonb', [JSON.stringify([
    mappedItem, { Code: managed.sku, ItemID: 'synthetic-original-item' },
  ])]);
  assert.deepEqual((await quoteLineItems(readOnlyDb, [managedSelection], now))[0],
    { ItemCode: managed.sku, ...managedExpected }, 'Matching unchanged store-managed code and ItemID may map.');
  console.log('PASS: real PostgreSQL stock descriptions, supplier/partial lead times, dated supply coverage, family reservations, ignored/RMA/inbound exclusions, stale/error fallback, actual fulfilled article, BIGSERIAL mapping, private metadata boundary and complete-snapshot item identity mapping.');
} finally {
  globalThis.fetch = originalFetch;
  if (pool) await pool.end();
  try {
    if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  } finally {
    await admin.end();
  }
}
