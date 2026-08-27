import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { currentUser } from "@/lib/auth/server";
import { ensureAuthSchema } from "@/lib/auth/schema";
import { parseVictronBackordersHtml } from "@/lib/victron-provisional-cart";
async function admin() {
  return (await currentUser())?.role === "admin";
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
    const lines = new Map<string, number>();
    for (const order of parseVictronBackordersHtml(await file.text()))
      for (const line of order.lines)
        lines.set(line.sku, (lines.get(line.sku) || 0) + line.quantity);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM victron_provisional_backorder_lines");
      for (const [sku, quantity] of lines)
        await client.query(
          "INSERT INTO victron_provisional_backorder_lines (sku, quantity) VALUES ($1, $2)",
          [sku, quantity],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return NextResponse.json({ ok: true, lineCount: lines.size });
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
export async function DELETE() {
  if (!(await admin()))
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403 },
    );
  await ensureAuthSchema();
  await pool.query("DELETE FROM victron_provisional_backorder_lines");
  return NextResponse.json({ ok: true });
}
