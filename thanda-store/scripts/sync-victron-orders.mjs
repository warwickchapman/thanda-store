#!/usr/bin/env node

import { createPool } from "./product-sync-lib.mjs";
import { syncVictronOrders } from "../src/lib/victron-order-sync.mjs";

const apiKey = process.env.VICTRON_EORDER_API_KEY;
if (!apiKey) {
  console.error("VICTRON_EORDER_API_KEY is required.");
  process.exit(1);
}

const pool = createPool();
try {
  const result = await syncVictronOrders({
    pool,
    apiKey,
    apiRoot:
      process.env.VICTRON_EORDER_API_ROOT ||
      "https://eorder.victronenergy.com/api/v1",
    configuredCutoverDate: process.env.VICTRON_ORDERS_CUTOVER_DATE || "",
    timeoutMs: Number(process.env.VICTRON_REQUEST_TIMEOUT_MS || 20_000),
  });
  console.log(JSON.stringify({ supplier: "victron", orders: result }, null, 2));
} catch (error) {
  console.error(
    "Victron shipment/backorder sync failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
