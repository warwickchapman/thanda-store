import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { currentUser } from "@/lib/auth/server";
import { ensureAuthSchema } from "@/lib/auth/schema";
import { parseVictronBackordersHtml } from "@/lib/victron-provisional-cart";
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
    SELECT backorder.order_number, backorder.uploaded_at,
      COALESCE(jsonb_agg(jsonb_build_object(
        'sku', line.sku,
        'description', line.description,
        'quantity', line.quantity
      ) ORDER BY line.sku) FILTER (WHERE line.sku IS NOT NULL), '[]'::jsonb) AS lines
    FROM victron_provisional_backorders backorder
    LEFT JOIN victron_provisional_backorder_order_lines line
      ON line.order_number = backorder.order_number
    GROUP BY backorder.order_number, backorder.uploaded_at
    ORDER BY backorder.order_number DESC
  `);
  return NextResponse.json({ orders: result.rows });
}

export async function POST(request: Request) {
  if (!(await admin()))
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403 },
    );
  await ensureAuthSchema();
  const file = (await request.formData()).get("backordersHtml");
  if (!(file instanceof File) || !file.size || file.size > 2_000_000)
    return NextResponse.json(
      { error: "Upload a saved E-Order Backorders HTML file of up to 2 MB." },
      { status: 400 },
    );
  try {
    const ordersByNumber = new Map<
      string,
      Map<string, { sku: string; description: string; quantity: number }>
    >();
    for (const order of parseVictronBackordersHtml(await file.text())) {
      const lines = ordersByNumber.get(order.orderNumber) || new Map();
      ordersByNumber.set(order.orderNumber, lines);
      for (const line of order.lines) {
        const existing = lines.get(line.sku);
        lines.set(line.sku, {
          sku: line.sku,
          description: existing?.description || line.description,
          quantity: (existing?.quantity || 0) + line.quantity,
        });
      }
    }
    const orders = [...ordersByNumber].map(([orderNumber, lines]) => ({
      orderNumber,
      lines: [...lines.values()],
    }));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM victron_provisional_backorders");
      for (const order of orders) {
        await client.query(
          "INSERT INTO victron_provisional_backorders (order_number) VALUES ($1)",
          [order.orderNumber],
        );
        for (const line of order.lines)
          await client.query(
            `INSERT INTO victron_provisional_backorder_order_lines
              (order_number, sku, description, quantity)
             VALUES ($1, $2, $3, $4)`,
            [order.orderNumber, line.sku, line.description, line.quantity],
          );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return NextResponse.json({
      ok: true,
      orderCount: orders.length,
      lineCount: orders.reduce((count, order) => count + order.lines.length, 0),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to read Backorders.",
      },
      { status: 400 },
    );
  }
}
export async function DELETE(request: Request) {
  if (!(await admin()))
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403 },
    );
  await ensureAuthSchema();
  let body: { orderNumber?: unknown; sku?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Choose a backorder item to clear." },
      { status: 400 },
    );
  }
  const orderNumber = String(body.orderNumber || "").trim();
  const sku = String(body.sku || "")
    .trim()
    .toUpperCase();
  if (!/^\d+$/.test(orderNumber) || !/^[A-Z0-9-]{3,}$/.test(sku))
    return NextResponse.json(
      { error: "Choose a valid backorder item to clear." },
      { status: 400 },
    );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const removed = await client.query(
      `DELETE FROM victron_provisional_backorder_order_lines
       WHERE order_number = $1 AND sku = $2`,
      [orderNumber, sku],
    );
    if (!removed.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "That backorder item is no longer present." },
        { status: 404 },
      );
    }
    await client.query(
      `DELETE FROM victron_provisional_backorders backorder
       WHERE backorder.order_number = $1
         AND NOT EXISTS (
           SELECT 1 FROM victron_provisional_backorder_order_lines line
           WHERE line.order_number = backorder.order_number
         )`,
      [orderNumber],
    );
    await client.query("COMMIT");
    return NextResponse.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
