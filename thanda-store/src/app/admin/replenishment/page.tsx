"use client";

import Link from "next/link";
import {
  ChevronDown,
  ChevronUp,
  FileUp,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type ReportItem = {
  sku: string;
  name: string;
  sales30: number;
  sales90: number;
  dailyDemand: number;
  localStock: number;
  inbound: number;
  backorder: number;
  provisional: number;
  supplierStock: number;
  minimumStock: number;
  predecessorSkus: string[];
  note: string | null;
  daysCover: number | null;
  reorderPoint: number;
  targetStock: number;
  suggestedOrder: number;
  status: "order_now" | "top_up" | "covered" | "satisfied" | "in_cart";
  lastSoldAt: string | null;
};
type Report = {
  items: ReportItem[];
  provisionalCart: {
    lineCount: number;
    uploadedAt: string | null;
    unmatchedLines: { sku: string; quantity: number }[];
  };
  policy: {
    leadTimeDays: number;
    safetyStockDays: number;
    targetCoverDays: number;
  };
};
type SortKey =
  | "item"
  | "sales30"
  | "sales90"
  | "minimumStock"
  | "localStock"
  | "inbound"
  | "backorder"
  | "provisional"
  | "daysCover"
  | "reorderPoint"
  | "suggestedOrder"
  | "status";
type SortDirection = "asc" | "desc";
const number = (value: number, maximumFractionDigits = 0) =>
  new Intl.NumberFormat("en-ZA", { maximumFractionDigits }).format(value);

function SortHeader({
  column,
  label,
  selected,
  direction,
  onSelect,
  className = "",
  align = "right",
}: {
  column: SortKey;
  label: string;
  selected: boolean;
  direction: SortDirection;
  onSelect: (key: SortKey) => void;
  className?: string;
  align?: "left" | "right";
}) {
  const background = className.includes("bg-") ? "" : "bg-zinc-50";
  const [itemSearchOpen, setItemSearchOpen] = useState(false);
  const [itemSearch, setItemSearch] = useState("");
  useEffect(() => {
    if (column !== "item") return;
    const handleSearch = (event: Event) => {
      const detail = (event as CustomEvent<{ value?: string; open?: boolean }>)
        .detail;
      if (detail.open) setItemSearchOpen(true);
      if (typeof detail.value === "string") {
        setItemSearch(detail.value);
        setItemSearchOpen(true);
      }
    };
    window.addEventListener("replenishment-item-search", handleSearch);
    return () =>
      window.removeEventListener("replenishment-item-search", handleSearch);
  }, [column]);
  if (column === "item")
    return (
      <th
        aria-sort={
          selected ? (direction === "asc" ? "ascending" : "descending") : "none"
        }
        className={`sticky top-0 z-10 px-4 py-3 shadow-sm ${background} ${className}`}
      >
        <div className="flex min-w-[220px] items-center gap-1">
          {itemSearchOpen ? (
            <input
              autoFocus
              type="search"
              value={itemSearch}
              onChange={(event) => {
                setItemSearch(event.target.value);
                window.dispatchEvent(
                  new CustomEvent("replenishment-item-search", {
                    detail: { value: event.target.value },
                  }),
                );
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setItemSearch("");
                  setItemSearchOpen(false);
                  window.dispatchEvent(
                    new CustomEvent("replenishment-item-search", {
                      detail: { value: "" },
                    }),
                  );
                }
              }}
              placeholder="Find SKU or name"
              aria-label="Filter items to order"
              className="h-7 w-40 rounded border border-sky-400 bg-white px-2 normal-case tracking-normal text-zinc-950 outline-none ring-sky-200 focus:ring-2"
            />
          ) : (
            <button
              type="button"
              onClick={() => setItemSearchOpen(true)}
              className="shrink-0 whitespace-nowrap text-left hover:text-zinc-950"
            >
              {label}
            </button>
          )}
          <button
            type="button"
            onClick={() => onSelect(column)}
            aria-label="Sort by item"
            title="Sort by item"
            className="flex min-w-8 flex-1 justify-end hover:text-zinc-950"
          >
            {selected ? (
              direction === "asc" ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )
            ) : (
              <span className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        </div>
      </th>
    );
  return (
    <th
      aria-sort={
        selected ? (direction === "asc" ? "ascending" : "descending") : "none"
      }
      className={`sticky top-0 z-10 px-3 py-3 shadow-sm ${background} ${className}`}
    >
      <button
        type="button"
        onClick={() => onSelect(column)}
        className={`inline-flex w-full items-center gap-1 whitespace-nowrap hover:text-zinc-950 ${align === "right" ? "justify-end" : "justify-start"}`}
      >
        {label}
        {selected ? (
          direction === "asc" ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )
        ) : (
          <span className="w-3.5" aria-hidden="true" />
        )}
      </button>
    </th>
  );
}

function ItemNote({
  item,
  editing,
  value,
  saving,
  onStart,
  onChange,
  onSave,
  onCancel,
}: {
  item: ReportItem;
  editing: boolean;
  value: string;
  saving: boolean;
  onStart: () => void;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [addingDetails, setAddingDetails] = useState(false);
  const [predecessorSku, setPredecessorSku] = useState("");
  const [detailsError, setDetailsError] = useState("");
  const [savingDetails, setSavingDetails] = useState(false);
  async function addDetails() {
    setSavingDetails(true);
    setDetailsError("");
    try {
      const response = await fetch("/api/admin/victron-sku-successions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ predecessorSku, successorSku: item.sku }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Unable to save the predecessor SKU.");
      window.location.reload();
    } catch (cause) {
      setDetailsError(
        cause instanceof Error
          ? cause.message
          : "Unable to save the predecessor SKU.",
      );
    } finally {
      setSavingDetails(false);
    }
  }
  const details = item.predecessorSkus.length > 0 && (
    <details className="relative">
      <summary className="cursor-pointer whitespace-nowrap text-xs font-semibold text-violet-800">
        Details
      </summary>
      <div className="absolute right-0 top-5 z-20 w-64 rounded border border-violet-200 bg-white p-2 text-xs text-violet-950 shadow-lg">
        Sales include predecessor: {item.predecessorSkus.join(", ")}
      </div>
    </details>
  );
  const addDetail = !item.predecessorSkus.length && (
    <button
      type="button"
      onClick={() => setAddingDetails(true)}
      className="whitespace-nowrap text-xs font-semibold text-violet-800 opacity-0 hover:text-violet-950 focus:opacity-100 group-hover:opacity-100"
    >
      + Details
    </button>
  );
  const savedNote = item.note && (
    <details className="relative">
      <summary className="cursor-pointer whitespace-nowrap text-xs font-semibold text-sky-800">
        Note
      </summary>
      <div className="absolute right-0 top-5 z-20 w-64 rounded border border-sky-200 bg-white p-2 text-xs text-sky-950 shadow-lg">
        <p className="whitespace-pre-wrap">{item.note}</p>
        <button
          type="button"
          onClick={onStart}
          className="mt-1 text-xs font-semibold text-sky-800 underline"
        >
          Edit note
        </button>
      </div>
    </details>
  );
  const controls = (details || addDetail || savedNote) && (
    <div
      className={`absolute top-2 z-20 flex items-start gap-2 ${item.note ? "right-2" : "right-14"}`}
    >
      {details}
      {addDetail}
      {savedNote}
    </div>
  );
  if (addingDetails)
    return (
      <>
        {controls}
        <div className="mt-2 max-w-md rounded border border-violet-200 bg-violet-50 p-2">
          <label className="grid gap-1 text-xs font-semibold text-violet-950">
            Predecessor SKU for {item.sku}
            <input
              autoFocus
              value={predecessorSku}
              onChange={(event) =>
                setPredecessorSku(event.target.value.toUpperCase())
              }
              placeholder="e.g. SCC145110510"
              className="h-8 rounded border border-violet-300 bg-white px-2 font-mono text-sm"
            />
          </label>
          {detailsError && (
            <p className="mt-1 text-xs font-semibold text-red-800">
              {detailsError}
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => void addDetails()}
              disabled={!predecessorSku || savingDetails}
              className="text-xs font-semibold text-violet-800 disabled:opacity-60"
            >
              {savingDetails ? "Saving" : "Save details"}
            </button>
            <button
              type="button"
              onClick={() => {
                setAddingDetails(false);
                setDetailsError("");
              }}
              disabled={savingDetails}
              className="text-xs font-semibold text-zinc-600"
            >
              Cancel
            </button>
          </div>
        </div>
      </>
    );
  if (editing)
    return (
      <>
        {controls}
        <div className="mt-2 max-w-md">
          <textarea
            autoFocus
            value={value}
            onChange={(event) => onChange(event.target.value)}
            maxLength={2000}
            rows={2}
            aria-label={`Note for ${item.sku}`}
            className="w-full rounded border border-sky-400 bg-white p-2 text-xs text-zinc-800 outline-none focus:ring-2 focus:ring-sky-200"
          />
          <div className="mt-1 flex gap-2">
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              className="text-xs font-semibold text-sky-800 disabled:opacity-60"
            >
              {saving ? "Saving" : "Save note"}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="text-xs font-semibold text-zinc-600 disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      </>
    );
  return controls;
}

export default function ReplenishmentPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("suggestedOrder");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [itemSearch, setItemSearch] = useState("");
  const [editingMinimum, setEditingMinimum] = useState<string | null>(null);
  const [minimumValue, setMinimumValueState] = useState("");
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [noteValue, setNoteValue] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [cartFile, setCartFile] = useState<File | null>(null);
  const [cartBusy, setCartBusy] = useState(false);
  const cancelMinimumEdit = useRef(false);
  const minimumValueRef = useRef("");
  const cartFileInput = useRef<HTMLInputElement>(null);
  const setMinimumValue = (value: string) => {
    minimumValueRef.current = value;
    setMinimumValueState(value);
  };
  async function load() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/replenishment", {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          data.error || "Unable to load the replenishment report.",
        );
      setReport(data);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to load the report.",
      );
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    const onItemSearch = (event: Event) => {
      const value = (event as CustomEvent<{ value?: string }>).detail.value;
      if (typeof value === "string") setItemSearch(value);
    };
    window.addEventListener("replenishment-item-search", onItemSearch);
    return () =>
      window.removeEventListener("replenishment-item-search", onItemSearch);
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      )
        return;
      event.preventDefault();
      window.dispatchEvent(
        new CustomEvent("replenishment-item-search", {
          detail: { open: true },
        }),
      );
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const items = useMemo(() => {
    const query = itemSearch.trim().toLocaleLowerCase();
    return [...(report?.items || [])]
      .filter(
        (item) =>
          !query ||
          `${item.sku} ${item.name}`.toLocaleLowerCase().includes(query),
      )
      .sort((left, right) => {
        const ranks = {
          order_now: 0,
          top_up: 1,
          in_cart: 2,
          satisfied: 3,
          covered: 4,
        } as const;
        const value = (item: ReportItem) =>
          sortKey === "item"
            ? `${item.sku} ${item.name}`
            : sortKey === "status"
              ? ranks[item.status]
              : sortKey === "daysCover"
                ? (item.daysCover ?? Number.POSITIVE_INFINITY)
                : item[sortKey];
        const leftValue = value(left);
        const rightValue = value(right);
        const comparison =
          typeof leftValue === "string"
            ? leftValue.localeCompare(String(rightValue))
            : Number(leftValue) - Number(rightValue);
        return sortDirection === "asc" ? comparison : -comparison;
      });
  }, [itemSearch, report, sortDirection, sortKey]);
  function selectSort(key: SortKey) {
    if (key === sortKey)
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDirection(key === "item" || key === "status" ? "asc" : "desc");
    }
  }
  function beginMinimumEdit(item: ReportItem) {
    cancelMinimumEdit.current = false;
    setEditingMinimum(item.sku);
    setMinimumValue(String(item.minimumStock));
  }
  async function saveMinimum(item: ReportItem) {
    if (cancelMinimumEdit.current) {
      cancelMinimumEdit.current = false;
      return;
    }
    const minimumStock = Number(minimumValueRef.current);
    if (
      !Number.isInteger(minimumStock) ||
      minimumStock < 0 ||
      minimumStock > 10_000
    ) {
      setError("Minimum stock must be a whole number between 0 and 10,000.");
      return;
    }
    setError("");
    try {
      const response = await fetch("/api/admin/victron-stock-minima", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku: item.sku, minimumStock }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Unable to save the minimum stock.");
      setEditingMinimum(null);
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to save the minimum stock.",
      );
    }
  }
  function beginNoteEdit(item: ReportItem) {
    setEditingNote(item.sku);
    setNoteValue(item.note || "");
  }
  async function saveNote(item: ReportItem) {
    setSavingNote(true);
    setError("");
    try {
      const response = await fetch("/api/admin/replenishment", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku: item.sku, note: noteValue }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Unable to save the note.");
      setEditingNote(null);
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to save the note.",
      );
    } finally {
      setSavingNote(false);
    }
  }
  async function uploadCart() {
    if (!cartFile) {
      setError("Choose a saved Victron E-Order basket HTML file first.");
      return;
    }
    setCartBusy(true);
    setError("");
    setMessage("");
    try {
      const formData = new FormData();
      formData.set("cartHtml", cartFile);
      const response = await fetch("/api/admin/victron-provisional-cart", {
        method: "POST",
        body: formData,
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Unable to read this provisional cart.");
      setCartFile(null);
      if (cartFileInput.current) cartFileInput.current.value = "";
      setMessage(
        data.imported?.length
          ? `Loaded ${data.lineCount} cart lines and imported ${data.imported.join(", ")} from E-Order.`
          : `Loaded ${data.lineCount} cart lines.`,
      );
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to read this provisional cart.",
      );
    } finally {
      setCartBusy(false);
    }
  }
  async function clearCart() {
    setCartBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/admin/victron-provisional-cart", {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Unable to clear the provisional cart.");
      setMessage("Provisional cart cleared.");
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to clear the provisional cart.",
      );
    } finally {
      setCartBusy(false);
    }
  }
  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-6 flex flex-col justify-between gap-3 border-b border-zinc-200 pb-4 sm:flex-row sm:items-end">
          <div>
            <h1 className="text-2xl font-bold">Inventory planning</h1>
            <p className="text-sm text-zinc-500">
              Victron replenishment recommendations from sales, KZN stock, and
              open inbound deliveries.
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
          <span className="border-b-2 border-zinc-950 px-4 py-2 text-sm font-bold">
            Replenishment
          </span>
          <Link
            href="/admin/victron-inbound"
            className="px-4 py-2 text-sm font-semibold text-zinc-600 hover:text-zinc-950"
          >
            Inbound
          </Link>
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
        {error && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </div>
        )}
        {message && (
          <div className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800">
            {message}
          </div>
        )}
        {report && (
          <>
            <div className="mb-5 flex flex-col justify-between gap-3 rounded-lg border border-zinc-200 bg-white p-4 text-sm shadow-sm sm:flex-row sm:items-center">
              <p>
                <span className="font-bold">Policy:</span> higher of 30- or
                90-day sales rate, or the configured stock minimum;{" "}
                {report.policy.leadTimeDays}-day lead time;{" "}
                {report.policy.safetyStockDays}-day safety stock;{" "}
                {report.policy.targetCoverDays}-day target cover.
              </p>
              <button
                type="button"
                onClick={() => void load()}
                disabled={loading}
                className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-3 text-sm font-semibold disabled:opacity-60"
              >
                <RefreshCw className="h-4 w-4" />
                Refresh
              </button>
            </div>
            <section className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4 shadow-sm">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                <div>
                  <h2 className="font-bold text-amber-950">
                    Provisional E-Order cart
                  </h2>
                  <p className="mt-1 text-sm text-amber-900">
                    Upload a saved E-Order basket overview HTML file. Its
                    quantities are temporary, are not retained as an order, and
                    reduce the remaining suggested quantity.
                  </p>
                  {report.provisionalCart.lineCount > 0 && (
                    <p className="mt-2 text-sm font-semibold text-amber-950">
                      {report.provisionalCart.lineCount} cart line
                      {report.provisionalCart.lineCount === 1 ? "" : "s"}{" "}
                      currently applied
                      {report.provisionalCart.uploadedAt
                        ? ` · uploaded ${new Date(report.provisionalCart.uploadedAt).toLocaleString()}`
                        : ""}
                      .
                    </p>
                  )}
                </div>
                {report.provisionalCart.lineCount > 0 && (
                  <button
                    type="button"
                    onClick={() => void clearCart()}
                    disabled={cartBusy}
                    className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md border border-amber-300 bg-white px-3 text-sm font-semibold text-amber-950 disabled:opacity-60"
                  >
                    <Trash2 className="h-4 w-4" />
                    Clear cart
                  </button>
                )}
              </div>
              <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                <input
                  ref={cartFileInput}
                  type="file"
                  accept=".html,text/html"
                  onChange={(event) =>
                    setCartFile(event.target.files?.[0] || null)
                  }
                  className="block h-10 flex-1 rounded-md border border-amber-300 bg-white p-1.5 text-sm"
                />
                <button
                  type="button"
                  onClick={() => void uploadCart()}
                  disabled={!cartFile || cartBusy}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-amber-900 px-4 text-sm font-semibold text-white disabled:opacity-60"
                >
                  <FileUp className="h-4 w-4" />
                  {cartBusy
                    ? "Checking"
                    : report.provisionalCart.lineCount
                      ? "Replace cart"
                      : "Check cart"}
                </button>
              </div>
              {report.provisionalCart.unmatchedLines.length > 0 && (
                <p className="mt-3 text-sm font-semibold text-amber-900">
                  Not matched to the current Victron catalogue:{" "}
                  {report.provisionalCart.unmatchedLines
                    .map((line) => `${line.sku} × ${line.quantity}`)
                    .join(", ")}
                  . These lines do not reduce a replenishment recommendation.
                </p>
              )}
            </section>
          </>
        )}
        <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
          <div className="overflow-x-auto lg:overflow-visible">
            <table className="min-w-[1190px] w-full text-sm">
              <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <SortHeader
                    column="item"
                    label="Item to order"
                    selected={sortKey === "item"}
                    direction={sortDirection}
                    onSelect={selectSort}
                    className="rounded-tl-lg px-4"
                    align="left"
                  />
                  <SortHeader
                    column="sales30"
                    label="30d"
                    selected={sortKey === "sales30"}
                    direction={sortDirection}
                    onSelect={selectSort}
                    className="text-right"
                  />
                  <SortHeader
                    column="sales90"
                    label="90d"
                    selected={sortKey === "sales90"}
                    direction={sortDirection}
                    onSelect={selectSort}
                    className="text-right"
                  />
                  <SortHeader
                    column="minimumStock"
                    label="Min"
                    selected={sortKey === "minimumStock"}
                    direction={sortDirection}
                    onSelect={selectSort}
                    className="border-l border-zinc-300 bg-red-50 text-right font-bold text-red-800"
                  />
                  <SortHeader
                    column="localStock"
                    label="KZN stock"
                    selected={sortKey === "localStock"}
                    direction={sortDirection}
                    onSelect={selectSort}
                    className="bg-sky-100 text-right font-bold text-sky-950"
                  />
                  <SortHeader
                    column="inbound"
                    label="Inbound"
                    selected={sortKey === "inbound"}
                    direction={sortDirection}
                    onSelect={selectSort}
                    className="bg-green-50 text-right font-bold text-green-800"
                  />
                  <SortHeader
                    column="backorder"
                    label="Backorder"
                    selected={sortKey === "backorder"}
                    direction={sortDirection}
                    onSelect={selectSort}
                    className="bg-orange-50 text-right font-bold text-orange-800"
                  />
                  <SortHeader
                    column="provisional"
                    label="Provisional"
                    selected={sortKey === "provisional"}
                    direction={sortDirection}
                    onSelect={selectSort}
                    className="bg-amber-50 text-right font-bold text-amber-900"
                  />
                  <SortHeader
                    column="daysCover"
                    label="Days cover"
                    selected={sortKey === "daysCover"}
                    direction={sortDirection}
                    onSelect={selectSort}
                    className="text-right"
                  />
                  <SortHeader
                    column="suggestedOrder"
                    label="Suggested"
                    selected={sortKey === "suggestedOrder"}
                    direction={sortDirection}
                    onSelect={selectSort}
                    className="border-l border-zinc-300 text-right"
                  />
                  <SortHeader
                    column="status"
                    label="Status"
                    selected={sortKey === "status"}
                    direction={sortDirection}
                    onSelect={selectSort}
                    className="rounded-tr-lg border-l border-zinc-300 px-4 text-left"
                    align="left"
                  />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.sku} className="border-t border-zinc-100">
                    <td className="group relative px-4 py-3">
                      <p className="font-bold">{item.sku}</p>
                      <p className="text-xs text-zinc-500">
                        {item.name}
                        {item.lastSoldAt
                          ? ` · last sold ${new Date(item.lastSoldAt).toLocaleDateString()}`
                          : ""}
                      </p>
                      {!item.note && editingNote !== item.sku && (
                        <button
                          type="button"
                          onClick={() => beginNoteEdit(item)}
                          className="absolute right-2 top-2 text-xs font-medium text-zinc-400 opacity-0 hover:text-sky-800 focus:opacity-100 group-hover:opacity-100"
                        >
                          + Note
                        </button>
                      )}
                      <ItemNote
                        item={item}
                        editing={editingNote === item.sku}
                        value={noteValue}
                        saving={savingNote}
                        onStart={() => beginNoteEdit(item)}
                        onChange={setNoteValue}
                        onSave={() => void saveNote(item)}
                        onCancel={() => setEditingNote(null)}
                      />
                    </td>
                    <td className="px-3 py-3 text-right">
                      {number(item.sales30)}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {number(item.sales90)}
                    </td>
                    <td className="border-l border-zinc-300 bg-red-50 px-3 py-3 text-right text-red-800">
                      {editingMinimum === item.sku ? (
                        <input
                          autoFocus
                          type="number"
                          min="0"
                          max="10000"
                          step="1"
                          value={minimumValue}
                          onChange={(event) =>
                            setMinimumValue(event.target.value)
                          }
                          onBlur={() => void saveMinimum(item)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter")
                              event.currentTarget.blur();
                            if (event.key === "Escape") {
                              cancelMinimumEdit.current = true;
                              setEditingMinimum(null);
                            }
                          }}
                          aria-label={`Minimum stock for ${item.sku}`}
                          className="h-8 w-20 rounded border border-sky-400 bg-white px-2 text-right font-bold text-sky-950 outline-none ring-sky-200 focus:ring-2"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => beginMinimumEdit(item)}
                          title="Click to edit the minimum stock level"
                          className="rounded px-2 py-1 font-semibold hover:bg-sky-50 hover:text-sky-950"
                        >
                          {item.minimumStock ? number(item.minimumStock) : "—"}
                        </button>
                      )}
                    </td>
                    <td className="bg-sky-50 px-3 py-3 text-right text-base font-bold text-sky-950">
                      {number(item.localStock)}
                    </td>
                    <td className="bg-green-50 px-3 py-3 text-right font-bold text-green-800">
                      {number(item.inbound)}
                    </td>
                    <td className="bg-orange-50 px-3 py-3 text-right font-bold text-orange-800">
                      {item.backorder ? number(item.backorder) : "—"}
                    </td>
                    <td className="bg-amber-50 px-3 py-3 text-right font-bold text-amber-900">
                      {item.provisional ? number(item.provisional) : "—"}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {item.daysCover === null
                        ? "—"
                        : number(item.daysCover, 1)}
                    </td>
                    <td
                      className="border-l border-zinc-300 px-3 py-3 text-right font-bold"
                      title={`Configured Min: ${item.minimumStock}; 7-day Target: ${item.reorderPoint}; 14-day Target: ${item.targetStock}`}
                    >
                      {item.suggestedOrder ? number(item.suggestedOrder) : "—"}
                    </td>
                    <td className="border-l border-zinc-300 px-4 py-3">
                      <span
                        className={`inline-flex border px-2 py-0.5 text-xs font-semibold ${item.status === "order_now" ? "border-red-200 bg-red-50 text-red-800" : item.status === "top_up" || item.status === "in_cart" ? "border-amber-200 bg-amber-50 text-amber-900" : item.status === "satisfied" ? "border-sky-200 bg-sky-50 text-sky-800" : "border-green-200 bg-green-50 text-green-800"}`}
                      >
                        {item.status === "order_now"
                          ? "Order"
                          : item.status === "top_up"
                            ? "Top up"
                            : item.status === "in_cart"
                              ? "Partial"
                              : item.status === "satisfied"
                                ? "Satisfied"
                                : "Covered"}
                      </span>
                    </td>
                  </tr>
                ))}
                {!loading && !items.length && (
                  <tr>
                    <td
                      colSpan={11}
                      className="px-4 py-12 text-center text-sm text-zinc-500"
                    >
                      No Victron sales, provisional cart quantities, or
                      configured stock minimums are available yet.
                    </td>
                  </tr>
                )}
                {loading && (
                  <tr>
                    <td
                      colSpan={11}
                      className="px-4 py-12 text-center text-sm text-zinc-500"
                    >
                      Loading replenishment report…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
