"use client";

import Link from "next/link";
import { PackageCheck, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

type InboundLine = {
  id: number;
  sku: string;
  description: string;
  isStockItem: boolean;
  orderedQuantity: number;
  receivedQuantity: number;
  receivedAt: string | null;
};
type InboundOrder = {
  id: number;
  supplier_order_number: string;
  customer_purchase_order: string | null;
  api_managed: boolean;
  external_order_date: string | null;
  external_last_seen_at: string | null;
  external_finished: boolean | null;
  status: "open" | "received";
  created_at: string;
  received_at: string | null;
  lines: InboundLine[];
  documents: Array<{ id: number; filename: string }>;
  invoices: Array<{
    invoiceNumber: string;
    status: string | null;
    shipmentNumber: string | null;
    shippingDate: string | null;
  }>;
};
type Backorder = {
  order_number: string;
  order_date: string | null;
  reference: string | null;
  uploaded_at: string;
  lines: Array<{
    sku: string;
    description: string;
    quantity: number;
    plannedFor: string | null;
  }>;
};
type SyncState = {
  effective_cutover_date: string | null;
  last_successful_sync_at: string | null;
  next_allowed_at: string | null;
  last_error: string | null;
  last_stats: {
    shipmentsImported?: number;
    backordersImported?: number;
    rmaShipmentsExcluded?: number;
  } | null;
};

export default function VictronInboundPage() {
  const [orders, setOrders] = useState<InboundOrder[]>([]);
  const [backorders, setBackorders] = useState<Backorder[]>([]);
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [clearingBackorder, setClearingBackorder] = useState<string | null>(
    null,
  );
  const [receivingLine, setReceivingLine] = useState<number | null>(null);
  const [receivingOrder, setReceivingOrder] = useState<number | null>(null);

  async function loadOrders() {
    const [inboundResponse, backorderResponse] = await Promise.all([
      fetch("/api/admin/victron-inbound", { cache: "no-store" }),
      fetch("/api/admin/victron-inbound/backorders", { cache: "no-store" }),
    ]);
    const [inboundData, backorderData] = await Promise.all([
      inboundResponse.json(),
      backorderResponse.json(),
    ]);
    if (!inboundResponse.ok)
      throw new Error(
        inboundData.error || "Unable to load inbound Victron orders.",
      );
    if (!backorderResponse.ok)
      throw new Error(
        backorderData.error || "Unable to load Victron backorders.",
      );
    setOrders(inboundData.orders || []);
    setBackorders(backorderData.orders || []);
    setSyncState(inboundData.syncState || null);
  }
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadOrders().catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : "Unable to load orders.",
        ),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function syncVictron() {
    setSyncing(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/admin/victron-inbound/sync", {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Unable to synchronize Victron orders.");
      const result = data.result || {};
      setMessage(
        result.reason === "already_running"
          ? "A Victron synchronization is already running."
          : result.reason === "rate_limited"
            ? `Victron synchronization is paused until ${new Date(result.retryAt).toLocaleString()}.`
            : `Victron synchronized: ${result.shipmentsImported || 0} shipment orders and ${result.backordersImported || 0} backorder orders are current.`,
      );
      await loadOrders();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to synchronize Victron orders.",
      );
    } finally {
      setSyncing(false);
    }
  }

  async function clearBackorder(orderNumber: string, sku: string) {
    const key = `${orderNumber}:${sku}`;
    setClearingBackorder(key);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/admin/victron-inbound/backorders", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderNumber, sku }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Unable to clear the backorder item.");
      setMessage(`${sku} cleared from backorder ${orderNumber}.`);
      await loadOrders();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to clear the backorder item.",
      );
    } finally {
      setClearingBackorder(null);
    }
  }

  async function clearAllBackorders() {
    if (!window.confirm("Clear all transient Victron backorders?")) return;
    setClearingBackorder("*");
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/admin/victron-inbound/backorders", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Unable to clear backorders.");
      setMessage("All transient backorders cleared.");
      await loadOrders();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to clear backorders.",
      );
    } finally {
      setClearingBackorder(null);
    }
  }

  async function receiveLine(lineId: number) {
    setReceivingLine(lineId);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/admin/victron-inbound", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineId }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Unable to record receipt.");
      setMessage(
        data.complete
          ? "All stock lines are received. The next Xero stock reconciliation has been requested."
          : "Receipt recorded. The next Xero stock reconciliation has been requested.",
      );
      await loadOrders();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to record receipt.",
      );
    } finally {
      setReceivingLine(null);
    }
  }

  async function receivePartial(line: InboundLine) {
    const outstanding = line.orderedQuantity - line.receivedQuantity;
    const value = window.prompt(
      `Quantity received for ${line.sku} (maximum ${outstanding})`,
    );
    if (value === null) return;
    setReceivingLine(line.id);
    setError("");
    try {
      const response = await fetch("/api/admin/victron-inbound", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lineId: line.id,
          partialQuantity: Number(value),
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Unable to record partial receipt.");
      setMessage("Partial receipt recorded. The balance remains expected.");
      await loadOrders();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to record partial receipt.",
      );
    } finally {
      setReceivingLine(null);
    }
  }

  async function receiveAll(order: InboundOrder) {
    const outstanding = order.lines.filter(
      (line) => line.receivedQuantity < line.orderedQuantity,
    ).length;
    if (
      !window.confirm(
        `Confirm receipt of all ${outstanding} outstanding line${outstanding === 1 ? "" : "s"} on Victron order ${order.supplier_order_number}? This records each remaining quantity as received and cannot be undone.`,
      )
    )
      return;
    setReceivingOrder(order.id);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/admin/victron-inbound", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: order.id, receiveAll: true }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Unable to record full receipt.");
      setMessage(
        "All items were received. The next Xero stock reconciliation has been requested.",
      );
      await loadOrders();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to record full receipt.",
      );
    } finally {
      setReceivingOrder(null);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-6 flex flex-col justify-between gap-3 border-b border-zinc-200 pb-4 sm:flex-row sm:items-end">
          <div>
            <h1 className="text-2xl font-bold">Victron inbound stock</h1>
            <p className="text-sm text-zinc-500">
              Review E-Order shipments and backorders, then record the quantity
              physically received.
            </p>
          </div>
          <Link href="/" className="text-sm font-semibold text-zinc-700">
            Back to store
          </Link>
        </div>
        <nav
          className="mb-6 flex gap-1 border-b border-zinc-200"
          aria-label="Inventory planning"
        >
          <Link
            href="/admin/replenishment"
            className="px-4 py-2 text-sm font-semibold text-zinc-600 hover:text-zinc-950"
          >
            Replenishment
          </Link>
          <span className="border-b-2 border-zinc-950 px-4 py-2 text-sm font-bold">
            Inbound
          </span>
          <Link
            href="/admin/victron-stock-minima"
            className="px-4 py-2 text-sm font-semibold text-zinc-600 hover:text-zinc-950"
          >
            Minimums
          </Link>
          <Link
            href="/admin/replenishment/how-it-works"
            className="px-4 py-2 text-sm font-semibold text-zinc-600 hover:text-zinc-950"
          >
            How recommendations work
          </Link>
        </nav>
        {message && (
          <div className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800">
            {message}
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </div>
        )}

        <section className="mb-8 rounded-lg border border-sky-200 bg-sky-50 p-4 shadow-sm">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div>
              <h2 className="text-lg font-bold text-sky-950">
                Victron shipment and backorder sync
              </h2>
              <p className="mt-1 text-sm text-sky-900">
                E-Order supplies billed shipment quantities and the current
                backorder snapshot. Physical receipt is recorded only with the
                confirmation controls below; KZN stock continues to come from
                Xero.
              </p>
              <p className="mt-2 text-xs text-sky-800">
                {syncState?.last_successful_sync_at
                  ? `Last synchronized ${new Date(syncState.last_successful_sync_at).toLocaleString()} · cutover ${syncState.effective_cutover_date || "not set"} · ${syncState.last_stats?.rmaShipmentsExcluded || 0} RMA shipments excluded`
                  : "No successful API synchronization has been recorded yet."}
              </p>
              {syncState?.last_error && (
                <p className="mt-1 text-xs font-semibold text-red-700">
                  Last attempt: {syncState.last_error}
                </p>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => void clearAllBackorders()}
                disabled={
                  syncing || clearingBackorder !== null || !backorders.length
                }
                className="h-10 rounded-md border border-orange-300 bg-white px-4 text-sm font-semibold text-orange-950 disabled:opacity-60"
              >
                {clearingBackorder === "*" ? "Clearing" : "Clear backorders"}
              </button>
              <button
                type="button"
                onClick={() => void syncVictron()}
                disabled={syncing || clearingBackorder !== null}
                className="inline-flex h-10 items-center gap-2 rounded-md bg-sky-950 px-4 text-sm font-semibold text-white disabled:opacity-60"
              >
                <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
                {syncing ? "Synchronizing" : "Sync Victron"}
              </button>
            </div>
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold">Expected orders</h2>
              <p className="text-sm text-zinc-500">
                Backorders are shown first as a temporary Victron snapshot.
                Confirm inbound lines only after counting the physical items.
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                void loadOrders().catch((cause) =>
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Unable to refresh.",
                  ),
                )
              }
              className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 text-sm font-semibold"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>
          <div className="grid gap-4">
            {backorders.map((backorder) => (
              <article
                key={backorder.order_number}
                className="rounded-lg border border-orange-200 bg-orange-50 p-4 shadow-sm"
              >
                <div className="mb-3 flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
                  <div>
                    <h3 className="font-bold text-orange-950">
                      Victron backorder {backorder.order_number}
                    </h3>
                    <p className="text-sm text-orange-800">
                      {backorder.reference ? `${backorder.reference} · ` : ""}
                      Snapshot synchronized{" "}
                      {new Date(backorder.uploaded_at).toLocaleString()}
                    </p>
                  </div>
                  <span className="inline-flex h-6 self-start rounded-full bg-orange-100 px-2 text-xs font-bold text-orange-900">
                    Backorder · transient
                  </span>
                </div>
                <div className="divide-y divide-orange-200 border-t border-orange-200">
                  {backorder.lines.map((line) => (
                    <div
                      key={line.sku}
                      className="flex items-center justify-between gap-3 py-3"
                    >
                      <p className="font-semibold text-orange-950">
                        {line.sku}{" "}
                        <span className="font-normal text-orange-900">
                          · {line.description}
                        </span>
                      </p>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="text-sm font-semibold text-orange-900">
                          {line.quantity} remaining
                          {line.plannedFor
                            ? ` · planned ${new Date(line.plannedFor).toLocaleDateString()}`
                            : ""}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            void clearBackorder(
                              backorder.order_number,
                              line.sku,
                            )
                          }
                          disabled={clearingBackorder !== null}
                          className="h-8 rounded-md border border-orange-300 bg-white px-3 text-xs font-semibold text-orange-950 disabled:opacity-60"
                        >
                          {clearingBackorder ===
                          `${backorder.order_number}:${line.sku}`
                            ? "Clearing"
                            : "Clear"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </article>
            ))}
            {orders.map((order) => (
              <article
                key={order.id}
                className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm"
              >
                <div className="mb-3 flex flex-col justify-between gap-2 sm:flex-row">
                  <div>
                    <h3 className="font-bold">
                      Victron order {order.supplier_order_number}
                    </h3>
                    <p className="text-sm text-zinc-500">
                      {order.customer_purchase_order
                        ? `PO ${order.customer_purchase_order} · `
                        : ""}
                      {order.external_order_date
                        ? `Ordered ${new Date(order.external_order_date).toLocaleDateString()}`
                        : `Created ${new Date(order.created_at).toLocaleDateString()}`}
                    </p>
                    {order.invoices.length > 0 && (
                      <p className="mt-1 text-xs text-zinc-500">
                        E-Order invoices: {order.invoices.map((invoice) => invoice.invoiceNumber).join(", ")}
                      </p>
                    )}
                    {order.documents.length > 0 && (
                      <p className="mt-1 text-xs text-zinc-500">
                        Invoices:{" "}
                        {order.documents.map((document, index) => (
                          <span key={document.id}>
                            {index > 0 && ", "}
                            <a
                              href={`/api/admin/victron-inbound/documents/${document.id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="font-semibold text-zinc-700 underline"
                            >
                              {document.filename}
                            </a>
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex h-6 rounded-full px-2 text-xs font-bold ${order.status === "received" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-900"}`}
                    >
                      {order.status === "received"
                        ? "Received"
                        : "Awaiting receipt"}
                    </span>
                    {order.status === "open" && (
                      <button
                        type="button"
                        onClick={() => void receiveAll(order)}
                        disabled={
                          receivingOrder === order.id || receivingLine !== null
                        }
                        className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white disabled:opacity-60"
                      >
                        <PackageCheck className="h-4 w-4" />
                        {receivingOrder === order.id
                          ? "Recording all"
                          : "Receive all items"}
                      </button>
                    )}
                  </div>
                </div>
                <div className="divide-y divide-zinc-100 border-t border-zinc-100">
                  {order.lines.map((line) => (
                    <div
                      key={line.id}
                      className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div>
                        <p className="font-semibold">
                          {line.sku}{" "}
                          <span className="font-normal text-zinc-600">
                            · {line.description}
                          </span>
                        </p>
                        <p className="text-sm text-zinc-500">
                          {line.receivedQuantity}/{line.orderedQuantity}{" "}
                          received{" "}
                          {line.isStockItem
                            ? ""
                            : "· promotional/reference item"}
                        </p>
                      </div>
                      {line.receivedQuantity >= line.orderedQuantity ? (
                        <span className="text-sm font-semibold text-green-700">
                          Received
                        </span>
                      ) : (
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => void receiveLine(line.id)}
                            disabled={
                              receivingLine === line.id ||
                              receivingOrder !== null
                            }
                            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white disabled:opacity-60"
                          >
                            <PackageCheck className="h-4 w-4" />
                            {receivingLine === line.id
                              ? "Recording"
                              : "Confirm all"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void receivePartial(line)}
                            disabled={
                              receivingLine === line.id ||
                              receivingOrder !== null
                            }
                            className="h-9 rounded-md border border-zinc-300 bg-white px-3 text-sm font-semibold"
                          >
                            Confirm partial
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </article>
            ))}
            {!backorders.length && !orders.length && (
              <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
                No Victron shipments or backorders are currently expected.
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
