import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { currentUser } from "@/lib/auth/server";
import { ensureAuthSchema } from "@/lib/auth/schema";

async function admin() {
  return (await currentUser())?.role === "admin";
}

export async function GET() {
  if (!(await admin()))
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403 },
    );
  await ensureAuthSchema();
  const result = await pool.query(`
    SELECT backorder.order_number, backorder.order_date, backorder.reference,
      backorder.uploaded_at,
      COALESCE(jsonb_agg(jsonb_build_object(
        'sku', line.sku,
        'description', line.description,
        'quantity', line.quantity,
        'plannedFor', line.planned_for
      ) ORDER BY line.sku) FILTER (WHERE line.sku IS NOT NULL), '[]'::jsonb) AS lines
    FROM victron_provisional_backorders backorder
    LEFT JOIN victron_provisional_backorder_order_lines line
      ON line.order_number = backorder.order_number
    LEFT JOIN victron_backorder_ignored_lines ignored
      ON ignored.order_number = line.order_number AND ignored.sku = line.sku
    WHERE ignored.sku IS NULL
    GROUP BY backorder.order_number, backorder.order_date, backorder.reference,
      backorder.uploaded_at
    HAVING count(line.sku) > 0
    ORDER BY backorder.order_date DESC NULLS LAST, backorder.order_number DESC
  `);
  return NextResponse.json({ orders: result.rows });
}

export async function DELETE(request: Request) {
  if (!(await admin()))
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403 },
    );
  await ensureAuthSchema();
  const body = await request.json().catch(() => ({}));

  if (body.all === true) {
    await pool.query(`
      INSERT INTO victron_backorder_ignored_lines (order_number, sku)
      SELECT order_number, sku FROM victron_provisional_backorder_order_lines
      ON CONFLICT (order_number, sku) DO UPDATE SET cleared_at = NOW()
    `);
    return NextResponse.json({ ok: true });
  }

  const orderNumber = String(body.orderNumber || "").trim();
  const sku = String(body.sku || "").trim().toUpperCase();
  if (!orderNumber || !/^[A-Z0-9-]{3,}$/.test(sku))
    return NextResponse.json(
      { error: "Choose a valid backorder item to clear." },
      { status: 400 },
    );
  const present = await pool.query(
    `SELECT 1 FROM victron_provisional_backorder_order_lines
     WHERE order_number = $1 AND sku = $2`,
    [orderNumber, sku],
  );
  if (!present.rowCount)
    return NextResponse.json(
      { error: "That backorder item is no longer present." },
      { status: 404 },
    );
  await pool.query(
    `INSERT INTO victron_backorder_ignored_lines (order_number, sku)
     VALUES ($1, $2)
     ON CONFLICT (order_number, sku) DO UPDATE SET cleared_at = NOW()`,
    [orderNumber, sku],
  );
  return NextResponse.json({ ok: true });
}
