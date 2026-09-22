"use client";

import Link from "next/link";
import { Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Item = {
  sku: string;
  name: string;
  minimum_stock: string | number;
  source: string | null;
};
type EditableItem = Item & { minimumStock: number };
type ReviewItem = {
  sku: string;
  name: string | null;
  currentCatalogueSku: string | null;
  predecessorSkus: string[];
  minimumStock: number;
  sales30: number;
  sales90: number;
  target14: number;
  minimumCoverDays: number | null;
  flags: { noSales90: boolean; coverOver45: boolean; noCurrentCatalogueSku: boolean };
};
type ReviewFilter = "flagged" | "all" | "noSales90" | "coverOver45" | "noCurrentCatalogueSku";
type ReviewSortKey = "sku" | "minimumStock" | "sales30" | "sales90" | "target14" | "minimumCoverDays";
type SortDirection = "asc" | "desc";
const formatNumber = (value: number, maximumFractionDigits = 0) =>
  new Intl.NumberFormat("en-ZA", { maximumFractionDigits }).format(value);
const reviewColumns: Array<{ key: ReviewSortKey; label: string; align?: "left" | "right" }> = [
  { key: "sku", label: "Current procurement SKU", align: "left" },
  { key: "minimumStock", label: "Min" },
  { key: "sales90", label: "90d" },
  { key: "sales30", label: "30d" },
  { key: "target14", label: "14-day target" },
  { key: "minimumCoverDays", label: "Min cover" },
];

export default function VictronStockMinimaPage() {
  const [items, setItems] = useState<EditableItem[]>([]);
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [saved, setSaved] = useState<Map<string, number>>(new Map());
  const [query, setQuery] = useState("");
  const [showConfiguredOnly, setShowConfiguredOnly] = useState(true);
  const [view, setView] = useState<"edit" | "review">("edit");
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("flagged");
  const [reviewSortKey, setReviewSortKey] = useState<ReviewSortKey>("minimumCoverDays");
  const [reviewSortDirection, setReviewSortDirection] = useState<SortDirection>("desc");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function load() {
    const response = await fetch("/api/admin/victron-stock-minima", {
      cache: "no-store",
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Unable to load Victron stock minimums.");
    const loaded = (data.items as Item[]).map((item) => ({
      ...item,
      minimumStock: Number(item.minimum_stock) || 0,
    }));
    setItems(loaded);
    setSaved(new Map(loaded.map((item) => [item.sku, item.minimumStock])));
    setReviewItems((data.review as ReviewItem[]) || []);
  }
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch((cause) =>
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to load stock minimums.",
        ),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return items.filter(
      (item) =>
        (!showConfiguredOnly || item.minimumStock > 0) &&
        (!normalized ||
          `${item.sku} ${item.name}`.toLowerCase().includes(normalized)),
    );
  }, [items, query, showConfiguredOnly]);
  const changed = items.filter(
    (item) => saved.get(item.sku) !== item.minimumStock,
  );
  const visibleReview = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = reviewItems.filter((item) => {
      const matchesSearch = !normalized || `${item.sku} ${item.name || ""} ${item.predecessorSkus.join(" ")}`.toLowerCase().includes(normalized);
      const flagged = item.flags.noSales90 || item.flags.coverOver45 || item.flags.noCurrentCatalogueSku;
      const matchesFilter = reviewFilter === "all" ||
        (reviewFilter === "flagged" && flagged) ||
        (reviewFilter === "noSales90" && item.flags.noSales90) ||
        (reviewFilter === "coverOver45" && item.flags.coverOver45) ||
        (reviewFilter === "noCurrentCatalogueSku" && item.flags.noCurrentCatalogueSku);
      return matchesSearch && matchesFilter;
    });
    return [...filtered].sort((left, right) => {
      const compared = reviewSortKey === "sku"
        ? left.sku.localeCompare(right.sku)
        : (left[reviewSortKey] ?? -1) - (right[reviewSortKey] ?? -1);
      return reviewSortDirection === "asc" ? compared : -compared;
    });
  }, [query, reviewFilter, reviewItems, reviewSortDirection, reviewSortKey]);
  function selectReviewSort(key: ReviewSortKey) {
    if (reviewSortKey === key)
      setReviewSortDirection((direction) => direction === "asc" ? "desc" : "asc");
    else {
      setReviewSortKey(key);
      setReviewSortDirection(key === "sku" ? "asc" : "desc");
    }
  }
  function update(sku: string, value: string) {
    const minimumStock = Math.max(0, Math.trunc(Number(value) || 0));
    setItems((current) =>
      current.map((item) =>
        item.sku === sku ? { ...item, minimumStock } : item,
      ),
    );
  }
  async function save() {
    if (!changed.length) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/admin/victron-stock-minima", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: changed.map(({ sku, minimumStock }) => ({
            sku,
            minimumStock,
          })),
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Unable to save stock minimums.");
      await load();
      setMessage(
        `Saved ${data.updated} stock minimum${data.updated === 1 ? "" : "s"}.`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to save stock minimums.",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-6 flex flex-col justify-between gap-3 border-b border-zinc-200 pb-4 sm:flex-row sm:items-end">
          <div>
            <h1 className="text-2xl font-bold">Inventory planning</h1>
            <p className="text-sm text-zinc-500">
              Maintain the hard minimum KZN stock level for each current Victron
              SKU.
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
          <Link
            href="/admin/victron-inbound"
            className="px-4 py-2 text-sm font-semibold text-zinc-600 hover:text-zinc-950"
          >
            Inbound
          </Link>
          <span className="border-b-2 border-zinc-950 px-4 py-2 text-sm font-bold">
            Minimums
          </span>
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
        <div className="mb-4 flex gap-2 border-b border-zinc-200">
          <button
            type="button"
            onClick={() => setView("edit")}
            className={`border-b-2 px-3 py-2 text-sm font-semibold ${view === "edit" ? "border-zinc-950 text-zinc-950" : "border-transparent text-zinc-500 hover:text-zinc-950"}`}
          >
            Edit minimums
          </button>
          <button
            type="button"
            onClick={() => setView("review")}
            className={`border-b-2 px-3 py-2 text-sm font-semibold ${view === "review" ? "border-zinc-950 text-zinc-950" : "border-transparent text-zinc-500 hover:text-zinc-950"}`}
          >
            Minimum review
          </button>
        </div>
        <div className="mb-5 flex flex-col justify-between gap-3 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-3 sm:flex-row">
            <label className="grid flex-1 gap-1 text-sm font-semibold">
              Find SKU or product
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search"
                className="h-10 rounded-md border border-zinc-300 px-3 font-normal"
              />
            </label>
            {view === "edit" ? (
              <label className="flex h-10 items-center gap-2 self-end text-sm font-semibold">
                <input
                  type="checkbox"
                  checked={showConfiguredOnly}
                  onChange={(event) =>
                    setShowConfiguredOnly(event.target.checked)
                  }
                />
                Configured only
              </label>
            ) : (
              <label className="grid gap-1 text-sm font-semibold">
                Show
                <select
                  value={reviewFilter}
                  onChange={(event) => setReviewFilter(event.target.value as ReviewFilter)}
                  className="h-10 rounded-md border border-zinc-300 bg-white px-3 font-normal"
                >
                  <option value="flagged">Review flags</option>
                  <option value="all">All configured minima</option>
                  <option value="noSales90">No sales in 90d</option>
                  <option value="coverOver45">Over 45 days cover</option>
                  <option value="noCurrentCatalogueSku">No current catalogue SKU</option>
                </select>
              </label>
            )}
          </div>
          {view === "edit" && (
            <button
              type="button"
              onClick={() => void save()}
              disabled={!changed.length || saving}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white disabled:opacity-60"
            >
              <Save className="h-4 w-4" />
              {saving
                ? "Saving"
                : changed.length
                  ? `Save ${changed.length} change${changed.length === 1 ? "" : "s"}`
                  : "Save changes"}
            </button>
          )}
        </div>
        {view === "edit" ? (
          <section className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm">
            <table className="min-w-[700px] w-full text-sm">
              <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-4 py-3">SKU</th>
                  <th className="px-4 py-3">Product</th>
                  <th className="px-4 py-3 text-right">Minimum KZN stock</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <tr key={item.sku} className="border-t border-zinc-100">
                    <td className="px-4 py-3 font-bold">{item.sku}</td>
                    <td className="px-4 py-3 text-zinc-700">{item.name}</td>
                    <td className="px-4 py-2 text-right">
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={item.minimumStock}
                        onChange={(event) => update(item.sku, event.target.value)}
                        className="h-9 w-28 rounded border border-zinc-300 px-2 text-right"
                      />
                    </td>
                  </tr>
                ))}
                {!visible.length && (
                  <tr>
                    <td colSpan={3} className="px-4 py-12 text-center text-sm text-zinc-500">
                      No matching current Victron products.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        ) : (
          <>
            <p className="mb-3 text-sm text-zinc-600">
              Review exception floors against invoiced sales. Flags are prompts for review, not automatic changes.
            </p>
            <section className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm">
              <table className="min-w-[1050px] w-full text-sm">
                <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    {reviewColumns.map((column) => (
                      <th key={column.key} className={`px-4 py-3 ${column.align === "left" ? "text-left" : "text-right"}`}>
                        <button
                          type="button"
                          onClick={() => selectReviewSort(column.key)}
                          className={`inline-flex items-center gap-1 hover:text-zinc-950 ${column.align === "left" ? "" : "w-full justify-end"}`}
                        >
                          {column.label}
                          {reviewSortKey === column.key && (reviewSortDirection === "asc" ? " ↑" : " ↓")}
                        </button>
                      </th>
                    ))}
                    <th className="px-4 py-3">Predecessors</th>
                    <th className="px-4 py-3">Review flags</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleReview.map((item) => {
                    const flags = [
                      item.flags.noSales90 && "No 90d sales",
                      item.flags.coverOver45 && "Over 45d cover",
                      item.flags.noCurrentCatalogueSku && "No current SKU",
                    ].filter(Boolean) as string[];
                    return (
                      <tr key={item.sku} className="border-t border-zinc-100 align-top">
                        <td className="px-4 py-3">
                          <p className="font-bold">{item.currentCatalogueSku || item.sku}</p>
                          <p className="text-zinc-600">{item.name || "No current Victron catalogue product"}</p>
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-red-800">{formatNumber(item.minimumStock)}</td>
                        <td className="px-4 py-3 text-right">{formatNumber(item.sales90)}</td>
                        <td className="px-4 py-3 text-right">{formatNumber(item.sales30)}</td>
                        <td className="px-4 py-3 text-right">{formatNumber(item.target14)}</td>
                        <td className="px-4 py-3 text-right">{item.minimumCoverDays === null ? "—" : `${formatNumber(item.minimumCoverDays, 1)} days`}</td>
                        <td className="px-4 py-3 font-mono text-xs text-violet-800">{item.predecessorSkus.length ? item.predecessorSkus.join(", ") : "—"}</td>
                        <td className="px-4 py-3">
                          {flags.length ? (
                            <div className="flex flex-wrap gap-1">
                              {flags.map((flag) => <span key={flag} className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900">{flag}</span>)}
                            </div>
                          ) : <span className="text-zinc-500">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                  {!visibleReview.length && (
                    <tr>
                      <td colSpan={8} className="px-4 py-12 text-center text-sm text-zinc-500">
                        No configured minimums match this review filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
