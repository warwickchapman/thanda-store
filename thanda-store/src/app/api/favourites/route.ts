import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { currentCatalogue, type CatalogueProduct } from '@/lib/catalogue';
import { currentUser } from '@/lib/auth/server';

const LIMIT = 20;

type InvoiceHistoryRow = {
  invoice_id: string;
  sku: string;
  invoice_date: string;
  quantity: string | number;
};

type SkuSuccession = {
  predecessor_sku: string;
  successor_sku: string;
};

function productIsOrderable(product: { stock_on_hand: number; details: Record<string, unknown> }) {
  const localStock = Number(product.details.localStockOnHand ?? 0);
  return localStock > 0 || Number(product.stock_on_hand) > 0;
}

function familyResolver(successions: SkuSuccession[]) {
  const parent = new Map<string, string>();
  const find = (sku: string): string => {
    const current = parent.get(sku) || sku;
    if (current === sku) return sku;
    const root = find(current);
    parent.set(sku, root);
    return root;
  };
  for (const succession of successions) {
    const predecessor = succession.predecessor_sku.toUpperCase();
    const successor = succession.successor_sku.toUpperCase();
    const predecessorRoot = find(predecessor);
    const successorRoot = find(successor);
    if (predecessorRoot !== successorRoot) parent.set(successorRoot, predecessorRoot);
  }
  return find;
}

function rankedProducts(
  rows: InvoiceHistoryRow[],
  products: Map<string, Awaited<ReturnType<typeof currentCatalogue>>[number]>,
  successions: SkuSuccession[],
  rankedByFrequency: boolean,
) {
  const resolveFamily = familyResolver(successions);
  const successorSkus = new Set(successions.map((row) => row.successor_sku.toUpperCase()));
  const liveSkusByFamily = new Map<string, Set<string>>();
  for (const sku of products.keys()) {
    const family = resolveFamily(sku);
    const members = liveSkusByFamily.get(family) || new Set<string>();
    members.add(sku);
    liveSkusByFamily.set(family, members);
  }
  const grouped = new Map<string, {
    skus: Set<string>;
    invoiceIds: Set<string>;
    units: number;
    lastOrdered: string;
    recent90: boolean;
    recent180: boolean;
  }>();

  for (const row of rows) {
    const sku = String(row.sku).toUpperCase();
    const family = resolveFamily(sku);
    const group = grouped.get(family) || {
      skus: new Set<string>(), invoiceIds: new Set<string>(), units: 0, lastOrdered: '', recent90: false, recent180: false,
    };
    group.skus.add(sku);
    group.invoiceIds.add(String(row.invoice_id));
    group.units += Number(row.quantity) || 0;
    if (row.invoice_date > group.lastOrdered) group.lastOrdered = row.invoice_date;
    const ageDays = (Date.now() - Date.parse(row.invoice_date)) / 86_400_000;
    if (ageDays <= 90) group.recent90 = true;
    if (ageDays <= 180) group.recent180 = true;
    grouped.set(family, group);
  }

  return [...grouped.values()].flatMap((group) => {
    const family = resolveFamily([...group.skus][0]);
    const memberSkus = [...(liveSkusByFamily.get(family) || group.skus)];
    const rootSkus = memberSkus.filter((sku) => !successorSkus.has(sku));
    const preferredSkus = [...rootSkus, ...memberSkus.filter((sku) => !rootSkus.includes(sku))];
    const familyProducts = preferredSkus.map((sku) => products.get(sku)).filter((product): product is CatalogueProduct => Boolean(product));
    const product = familyProducts.find(productIsOrderable) || familyProducts[0];
    if (!product) return [];
    const score = rankedByFrequency
      ? group.invoiceIds.size * 100 + (group.recent90 ? 20 : group.recent180 ? 10 : 0)
      : group.units;
    return [{ product, score, lastOrdered: group.lastOrdered, units: group.units }];
  }).sort((left, right) => right.score - left.score || right.lastOrdered.localeCompare(left.lastOrdered) || right.units - left.units)
    .slice(0, LIMIT)
    .map((row) => row.product);
}

export async function GET() {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const products = await currentCatalogue(user.discounts);
    const bySku = new Map(products.map((product) => [product.sku.toUpperCase(), product]));
    const cutoff = new Date();
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
    const start = cutoff.toISOString().slice(0, 10);

    const successionResult = await pool.query<SkuSuccession>(`
      SELECT predecessor_sku, successor_sku
      FROM victron_sku_successions
    `).catch((error: { code?: string }) => {
      // The supplier sync creates the table. Retain normal ranking during the
      // brief interval after an application deploy but before that first sync.
      if (error.code === '42P01') return { rows: [] as SkuSuccession[] };
      throw error;
    });
    const [mine, thanda] = await Promise.all([
      user.xeroContactId ? pool.query(`
        SELECT invoice_id, sku, invoice_date, quantity
        FROM xero_sales_invoice_lines
        WHERE contact_id = $1 AND invoice_date >= $2::date
      `, [user.xeroContactId, start]) : Promise.resolve({ rows: [] as InvoiceHistoryRow[] }),
      pool.query(`
        SELECT invoice_id, sku, invoice_date, quantity
        FROM xero_sales_invoice_lines
        WHERE invoice_date >= $1::date
      `, [start]),
    ]);
    return NextResponse.json({
      mine: rankedProducts(mine.rows, bySku, successionResult.rows, true),
      thanda: rankedProducts(thanda.rows, bySku, successionResult.rows, false),
      windowStart: start,
    });
  } catch (error) {
    console.error('Favourites API error:', error);
    return NextResponse.json({ error: 'Unable to load favourites' }, { status: 500 });
  }
}
