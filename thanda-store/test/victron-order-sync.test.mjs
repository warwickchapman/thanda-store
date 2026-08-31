import assert from "node:assert/strict";
import test from "node:test";
import {
  backorderQuantityAfterInbound,
  isRmaReference,
  isStockSku,
} from "../src/lib/victron-order-sync.mjs";
import { victronSkuFamilyResolver } from "../src/lib/victron-sku-family.mjs";

test("RMA shipment references are excluded case-insensitively", () => {
  assert.equal(isRmaReference("RMA 514.278/Sensible"), true);
  assert.equal(isRmaReference("customer rma replacement"), true);
  assert.equal(isRmaReference("20260821 - PO-4542"), false);
});

test("promotional and pseudo lines do not become inbound stock", () => {
  assert.equal(isStockSku("SAL060020020"), false);
  assert.equal(isStockSku("ORDER"), false);
  assert.equal(isStockSku("ORI124838110"), true);
});

test("a backorder already represented by open inbound is not double counted", () => {
  assert.equal(backorderQuantityAfterInbound(1, 1), 0);
  assert.equal(backorderQuantityAfterInbound(3, 1), 2);
  assert.equal(backorderQuantityAfterInbound(1, 3), 0);
});

test("retail and successor SKUs reconcile within the same planning family", () => {
  const familyFor = victronSkuFamilyResolver([
    { predecessor_sku: "PMP482305010", successor_sku: "PMP482305012" },
  ]);
  assert.equal(familyFor("PMP482305010R"), familyFor("PMP482305012"));
  assert.equal(backorderQuantityAfterInbound(2, 1), 1);
});
