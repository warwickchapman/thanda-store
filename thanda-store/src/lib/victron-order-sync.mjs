const DEFAULT_API_ROOT = "https://eorder.victronenergy.com/api/v1";
const DEFAULT_TIMEOUT_MS = 20_000;
const TRANSIENT_RETRY_DELAY_MS = 1_000;

class VictronRateLimitError extends Error {
  constructor(retryAfterSeconds) {
    super(
      `Victron rate limit reached${retryAfterSeconds ? `; retry after ${retryAfterSeconds} seconds` : ""}.`,
    );
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function clean(value) {
  return String(value || "").trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function rows(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.results) ? value.results : [];
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

export function isRmaReference(reference) {
  return /rma/i.test(clean(reference));
}

export function isStockSku(sku) {
  const normalized = upper(sku);
  return normalized !== "ORDER" && !normalized.startsWith("SAL");
}

export function backorderQuantityAfterInbound(backorder, inbound) {
  return Math.max(0, positiveInteger(backorder) - positiveInteger(inbound));
}

async function ensureSchema(client) {
  await client.query(
    `ALTER TABLE supplier_inbound_orders ALTER COLUMN created_by_user_id DROP NOT NULL`,
  );
  await client.query(
    `ALTER TABLE supplier_inbound_orders ADD COLUMN IF NOT EXISTS api_managed BOOLEAN NOT NULL DEFAULT false`,
  );
  await client.query(
    `ALTER TABLE supplier_inbound_orders ADD COLUMN IF NOT EXISTS external_order_date DATE`,
  );
  await client.query(
    `ALTER TABLE supplier_inbound_orders ADD COLUMN IF NOT EXISTS external_last_seen_at TIMESTAMPTZ`,
  );
  await client.query(
    `ALTER TABLE supplier_inbound_orders ADD COLUMN IF NOT EXISTS external_finished BOOLEAN`,
  );
  await client.query(`
    CREATE TABLE IF NOT EXISTS victron_shipment_orders (
      order_number TEXT PRIMARY KEY,
      order_date DATE NOT NULL,
      reference TEXT,
      finished BOOLEAN NOT NULL DEFAULT false,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS victron_shipment_invoices (
      invoice_number TEXT PRIMARY KEY,
      order_number TEXT NOT NULL REFERENCES victron_shipment_orders(order_number) ON DELETE CASCADE,
      status TEXT,
      products_url TEXT NOT NULL,
      shipment_number TEXT,
      shipping_date DATE,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      products_imported_at TIMESTAMPTZ
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS victron_shipment_invoice_lines (
      invoice_number TEXT NOT NULL REFERENCES victron_shipment_invoices(invoice_number) ON DELETE CASCADE,
      sku TEXT NOT NULL,
      quantity_ordered INTEGER NOT NULL CHECK (quantity_ordered > 0),
      PRIMARY KEY (invoice_number, sku)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS victron_order_sync_state (
      id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
      effective_cutover_date DATE,
      last_started_at TIMESTAMPTZ,
      last_completed_at TIMESTAMPTZ,
      last_successful_sync_at TIMESTAMPTZ,
      next_allowed_at TIMESTAMPTZ,
      last_error TEXT,
      last_stats JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(
    `INSERT INTO victron_order_sync_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING`,
  );
  await client.query(
    `ALTER TABLE victron_order_sync_state ADD COLUMN IF NOT EXISTS next_allowed_at TIMESTAMPTZ`,
  );
  await client.query(
    `ALTER TABLE victron_provisional_backorders ADD COLUMN IF NOT EXISTS order_date DATE`,
  );
  await client.query(
    `ALTER TABLE victron_provisional_backorders ADD COLUMN IF NOT EXISTS reference TEXT`,
  );
  await client.query(
    `ALTER TABLE victron_provisional_backorder_order_lines ADD COLUMN IF NOT EXISTS planned_for DATE`,
  );
  await client.query(`
    CREATE TABLE IF NOT EXISTS victron_backorder_ignored_lines (
      order_number TEXT NOT NULL,
      sku TEXT NOT NULL,
      cleared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (order_number, sku)
    )
  `);
}

function apiUrl(apiRoot, value) {
  const candidate = clean(value);
  if (/^https:\/\//i.test(candidate)) return candidate;
  return `${apiRoot.replace(/\/$/, "")}/${candidate.replace(/^\//, "")}`;
}

async function fetchJson(url, { apiKey, fetchImpl, timeoutMs }, attempt = 0) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        Authorization: apiKey,
        Accept: "application/json",
        "User-Agent": "ThandaStoreOrderSync/1.0",
      },
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (response.ok) return body;

    const retryAfter = Number(response.headers.get("retry-after") || 0);
    if (response.status === 429)
      throw new VictronRateLimitError(retryAfter);
    if (attempt === 0 && response.status >= 500) {
      await new Promise((resolve) =>
        setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS),
      );
      return fetchJson(url, { apiKey, fetchImpl, timeoutMs }, 1);
    }
    const detail = clean(body?.detail || body?.message || text).slice(0, 200);
    throw new Error(`Victron HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizedShipment(raw) {
  const orderNumber = clean(raw?.order_number);
  const orderDate = clean(raw?.order_date);
  if (!orderNumber || !/^\d{4}-\d{2}-\d{2}$/.test(orderDate)) return null;
  return {
    orderNumber,
    orderDate,
    reference: clean(raw?.reference) || null,
    finished: raw?.finished === true,
    invoices: rows(raw?.invoices)
      .map((invoice) => {
        const invoiceNumber = clean(invoice?.invoice_number);
        const productsUrl = clean(invoice?.invoice_products_url);
        if (!invoiceNumber || !productsUrl) return null;
        return {
          invoiceNumber,
          productsUrl,
          status: clean(invoice?.status) || null,
          shipmentNumber: clean(invoice?.shipment?.shipment_number) || null,
          shippingDate: clean(invoice?.shipment?.shipping_date) || null,
        };
      })
      .filter(Boolean),
  };
}

function normalizedBackorder(raw) {
  const orderNumber = clean(raw?.order_number);
  if (!orderNumber) return null;
  return {
    orderNumber,
    orderDate: clean(raw?.order_date) || null,
    reference: clean(raw?.reference) || null,
    lines: rows(raw?.backorder_items)
      .map((item) => ({
        sku: upper(item?.sku),
        description: clean(item?.description) || upper(item?.sku),
        quantity: positiveInteger(item?.remaining),
        plannedFor: clean(item?.planned_for) || null,
      }))
      .filter((item) => item.sku && item.quantity > 0),
  };
}

async function effectiveCutoverDate(
  client,
  shipments,
  configuredCutoverDate,
) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean(configuredCutoverDate)))
    return clean(configuredCutoverDate);
  const state = await client.query(
    `SELECT effective_cutover_date::text AS date FROM victron_order_sync_state WHERE id = true`,
  );
  if (state.rows[0]?.date) return state.rows[0].date;

  const open = await client.query(`
    SELECT supplier_order_number
    FROM supplier_inbound_orders
    WHERE supplier = 'victron' AND status = 'open'
  `);
  const openNumbers = new Set(
    open.rows.map((row) => clean(row.supplier_order_number)),
  );
  const matchingDates = shipments
    .filter((shipment) => openNumbers.has(shipment.orderNumber))
    .map((shipment) => shipment.orderDate)
    .sort();
  return matchingDates[0] || new Date().toISOString().slice(0, 10);
}

async function replaceBackorders(client, backorders) {
  await client.query("BEGIN");
  try {
    await client.query("DELETE FROM victron_provisional_backorders");
    for (const order of backorders) {
      if (isRmaReference(order.reference) || !order.lines.length) continue;
      await client.query(
        `INSERT INTO victron_provisional_backorders
          (order_number, order_date, reference, uploaded_at)
         VALUES ($1, $2, $3, NOW())`,
        [order.orderNumber, order.orderDate, order.reference],
      );
      for (const line of order.lines)
        await client.query(
          `INSERT INTO victron_provisional_backorder_order_lines
            (order_number, sku, description, quantity, planned_for)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            order.orderNumber,
            line.sku,
            line.description,
            line.quantity,
            line.plannedFor,
          ],
        );
    }
    await client.query(`
      DELETE FROM victron_backorder_ignored_lines ignored
      WHERE NOT EXISTS (
        SELECT 1 FROM victron_provisional_backorder_order_lines line
        WHERE line.order_number = ignored.order_number AND line.sku = ignored.sku
      )
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function importInvoiceProducts(client, invoice, products) {
  const bySku = new Map();
  for (const product of rows(products)) {
    const sku = upper(product?.sku);
    const quantity = positiveInteger(product?.quantity_ordered);
    if (!sku || !quantity) continue;
    bySku.set(sku, (bySku.get(sku) || 0) + quantity);
  }
  await client.query("BEGIN");
  try {
    await client.query(
      `DELETE FROM victron_shipment_invoice_lines WHERE invoice_number = $1`,
      [invoice.invoice_number],
    );
    for (const [sku, quantity] of bySku)
      await client.query(
        `INSERT INTO victron_shipment_invoice_lines
          (invoice_number, sku, quantity_ordered)
         VALUES ($1, $2, $3)`,
        [invoice.invoice_number, sku, quantity],
      );
    await client.query(
      `UPDATE victron_shipment_invoices SET products_imported_at = NOW() WHERE invoice_number = $1`,
      [invoice.invoice_number],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return bySku.size;
}

async function reconcileInboundOrder(client, orderNumber) {
  const shipment = await client.query(
    `SELECT order_number, order_date, reference, finished
     FROM victron_shipment_orders WHERE order_number = $1`,
    [orderNumber],
  );
  const external = shipment.rows[0];
  if (!external) return { created: false, lineCount: 0 };

  const totals = await client.query(
    `SELECT line.sku, SUM(line.quantity_ordered)::int AS quantity,
       COALESCE(MAX(product.name), line.sku) AS description
     FROM victron_shipment_invoice_lines line
     JOIN victron_shipment_invoices invoice ON invoice.invoice_number = line.invoice_number
     LEFT JOIN products product ON product.supplier = 'victron' AND UPPER(product.sku) = line.sku
     WHERE invoice.order_number = $1 AND COALESCE(invoice.status, '') <> 'Cancelled'
     GROUP BY line.sku`,
    [orderNumber],
  );
  if (!totals.rows.length) return { created: false, lineCount: 0 };

  await client.query("BEGIN");
  try {
    const inserted = await client.query(
      `INSERT INTO supplier_inbound_orders
        (supplier, supplier_order_number, customer_purchase_order, source,
         created_by_user_id, api_managed, external_order_date,
         external_last_seen_at, external_finished)
       VALUES ('victron', $1, $2, 'inbound', NULL, true, $3, NOW(), $4)
       ON CONFLICT (supplier, supplier_order_number) DO UPDATE SET
         customer_purchase_order = COALESCE(supplier_inbound_orders.customer_purchase_order, EXCLUDED.customer_purchase_order),
         api_managed = true,
         external_order_date = EXCLUDED.external_order_date,
         external_last_seen_at = NOW(),
         external_finished = EXCLUDED.external_finished
       RETURNING id, (xmax = 0) AS created`,
      [
        external.order_number,
        external.reference,
        external.order_date,
        external.finished,
      ],
    );
    const inboundOrderId = inserted.rows[0].id;
    const shipmentSkus = [];
    let increased = false;
    for (const row of totals.rows) {
      const quantity = positiveInteger(row.quantity);
      if (!quantity) continue;
      shipmentSkus.push(row.sku);
      const updated = await client.query(
        `INSERT INTO supplier_inbound_order_lines
          (inbound_order_id, sku, description, ordered_quantity, is_stock_item)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (inbound_order_id, sku) DO UPDATE SET
           description = CASE
             WHEN supplier_inbound_order_lines.description = supplier_inbound_order_lines.sku
               THEN EXCLUDED.description
             ELSE supplier_inbound_order_lines.description
           END,
           -- The Shipments API is authoritative for billed/expected units. An
           -- earlier cart or backorder import may have populated this order
           -- with quantities that were never shipped, so do not retain the
           -- larger legacy value. Never reduce below a physical receipt that
           -- has already been confirmed locally.
           ordered_quantity = GREATEST(supplier_inbound_order_lines.received_quantity, EXCLUDED.ordered_quantity),
           is_stock_item = EXCLUDED.is_stock_item
         RETURNING ordered_quantity > received_quantity AS outstanding`,
        [
          inboundOrderId,
          row.sku,
          clean(row.description) || row.sku,
          quantity,
          isStockSku(row.sku),
        ],
      );
      increased ||= updated.rows[0]?.outstanding === true;
    }
    // Remove unreceived legacy lines that are absent from the shipment
    // invoices. This is what keeps transient backorders out of green Inbound
    // while preserving any physical receipt already confirmed by an operator.
    await client.query(
      `DELETE FROM supplier_inbound_order_lines
       WHERE inbound_order_id = $1
         AND received_quantity = 0
         AND NOT (sku = ANY($2::text[]))`,
      [inboundOrderId, shipmentSkus],
    );
    if (increased)
      await client.query(
        `UPDATE supplier_inbound_orders SET status = 'open', received_at = NULL WHERE id = $1`,
        [inboundOrderId],
      );
    await client.query("COMMIT");
    return {
      created: inserted.rows[0].created === true,
      lineCount: totals.rows.length,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function syncVictronOrders({
  pool,
  apiKey,
  apiRoot = DEFAULT_API_ROOT,
  configuredCutoverDate = "",
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!apiKey) throw new Error("VICTRON_EORDER_API_KEY is required.");
  const client = await pool.connect();
  let locked = false;
  try {
    await ensureSchema(client);
    const lock = await client.query(
      `SELECT pg_try_advisory_lock(hashtext('victron-order-sync')) AS locked`,
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) return { skipped: true, reason: "already_running" };
    const allowance = await client.query(
      `SELECT next_allowed_at FROM victron_order_sync_state WHERE id = true`,
    );
    const nextAllowedAt = allowance.rows[0]?.next_allowed_at;
    if (nextAllowedAt && new Date(nextAllowedAt).getTime() > Date.now())
      return {
        skipped: true,
        reason: "rate_limited",
        retryAt: new Date(nextAllowedAt).toISOString(),
      };
    await client.query(
      `UPDATE victron_order_sync_state SET last_started_at = NOW(), last_error = NULL, updated_at = NOW() WHERE id = true`,
    );

    const fetchOptions = { apiKey, fetchImpl, timeoutMs };
    const [shipmentPayload, backorderPayload] = await Promise.all([
      fetchJson(
        `${apiRoot.replace(/\/$/, "")}/orders/shipments/?format=json`,
        fetchOptions,
      ),
      fetchJson(
        `${apiRoot.replace(/\/$/, "")}/orders/backorders/?format=json`,
        fetchOptions,
      ),
    ]);
    const allShipments = rows(shipmentPayload)
      .map(normalizedShipment)
      .filter(Boolean);
    const allBackorders = rows(backorderPayload)
      .map(normalizedBackorder)
      .filter(Boolean);
    const cutoverDate = await effectiveCutoverDate(
      client,
      allShipments,
      configuredCutoverDate,
    );
    const openOrders = await client.query(`
      SELECT supplier_order_number FROM supplier_inbound_orders
      WHERE supplier = 'victron' AND status = 'open'
    `);
    const openOrderNumbers = new Set(
      openOrders.rows.map((row) => clean(row.supplier_order_number)),
    );
    const shipments = allShipments.filter(
      (shipment) =>
        !isRmaReference(shipment.reference) &&
        (shipment.orderDate >= cutoverDate ||
          openOrderNumbers.has(shipment.orderNumber)),
    );

    for (const shipment of shipments) {
      await client.query(
        `INSERT INTO victron_shipment_orders
          (order_number, order_date, reference, finished, last_seen_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (order_number) DO UPDATE SET
           order_date = EXCLUDED.order_date,
           reference = EXCLUDED.reference,
           finished = EXCLUDED.finished,
           last_seen_at = NOW()`,
        [
          shipment.orderNumber,
          shipment.orderDate,
          shipment.reference,
          shipment.finished,
        ],
      );
      for (const invoice of shipment.invoices) {
        if (invoice.status === "Cancelled") continue;
        await client.query(
          `INSERT INTO victron_shipment_invoices
            (invoice_number, order_number, status, products_url,
             shipment_number, shipping_date, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (invoice_number) DO UPDATE SET
             order_number = EXCLUDED.order_number,
             status = EXCLUDED.status,
             products_url = EXCLUDED.products_url,
             shipment_number = EXCLUDED.shipment_number,
             shipping_date = EXCLUDED.shipping_date,
             last_seen_at = NOW()`,
          [
            invoice.invoiceNumber,
            shipment.orderNumber,
            invoice.status,
            invoice.productsUrl,
            invoice.shipmentNumber,
            invoice.shippingDate,
          ],
        );
      }
    }

    const missingInvoices = await client.query(`
      SELECT invoice_number, products_url
      FROM victron_shipment_invoices
      WHERE products_imported_at IS NULL
      ORDER BY invoice_number
    `);
    let importedInvoiceLines = 0;
    for (const invoice of missingInvoices.rows) {
      const products = await fetchJson(
        apiUrl(apiRoot, invoice.products_url),
        fetchOptions,
      );
      importedInvoiceLines += await importInvoiceProducts(
        client,
        invoice,
        products,
      );
    }

    let createdOrders = 0;
    for (const shipment of shipments) {
      const result = await reconcileInboundOrder(client, shipment.orderNumber);
      if (result.created) createdOrders += 1;
    }
    await replaceBackorders(client, allBackorders);

    const stats = {
      cutoverDate,
      calls: 2 + missingInvoices.rowCount,
      shipmentsSeen: allShipments.length,
      shipmentsImported: shipments.length,
      invoicesFetched: missingInvoices.rowCount,
      invoiceLinesImported: importedInvoiceLines,
      inboundOrdersCreated: createdOrders,
      backordersImported: allBackorders.filter(
        (order) => !isRmaReference(order.reference) && order.lines.length,
      ).length,
      rmaShipmentsExcluded: allShipments.filter((shipment) =>
        isRmaReference(shipment.reference),
      ).length,
    };
    await client.query(
      `UPDATE victron_order_sync_state SET
         effective_cutover_date = $1,
         last_completed_at = NOW(),
         last_successful_sync_at = NOW(),
         next_allowed_at = NULL,
         last_error = NULL,
         last_stats = $2::jsonb,
         updated_at = NOW()
       WHERE id = true`,
      [cutoverDate, JSON.stringify(stats)],
    );
    return stats;
  } catch (error) {
    const retryAfterSeconds =
      error instanceof VictronRateLimitError
        ? error.retryAfterSeconds
        : 0;
    await client
      .query(
        `UPDATE victron_order_sync_state SET
           last_completed_at = NOW(),
           next_allowed_at = CASE WHEN $2::int > 0
             THEN NOW() + ($2::int * INTERVAL '1 second')
             ELSE next_allowed_at END,
           last_error = $1, updated_at = NOW()
         WHERE id = true`,
        [
          error instanceof Error ? error.message.slice(0, 1000) : "Unknown error",
          retryAfterSeconds,
        ],
      )
      .catch(() => undefined);
    throw error;
  } finally {
    if (locked)
      await client
        .query(`SELECT pg_advisory_unlock(hashtext('victron-order-sync'))`)
        .catch(() => undefined);
    client.release();
  }
}
