import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { currentUser } from "@/lib/auth/server";
import { ensureAuthSchema } from "@/lib/auth/schema";
import { syncVictronOrders } from "@/lib/victron-order-sync.mjs";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST() {
  const user = await currentUser();
  if (!user || user.role !== "admin")
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403 },
    );
  const apiKey = process.env.VICTRON_EORDER_API_KEY;
  if (!apiKey)
    return NextResponse.json(
      { error: "Victron E-Order API credentials are not configured." },
      { status: 503 },
    );

  await ensureAuthSchema();
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
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    console.error("Manual Victron order sync failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to synchronize Victron orders.",
      },
      { status: 502 },
    );
  }
}
