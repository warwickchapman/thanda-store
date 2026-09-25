import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { assertHubSnapshot } from "@/lib/xero/hub.mjs";
import { currentUser } from "@/lib/auth/server";
import { ensureAuthSchema } from "@/lib/auth/schema";
import { xeroAccountingFetch } from "@/lib/xero/oauth";
import {
  acceptedQuoteReservationDays,
  replaceAcceptedQuoteSnapshot,
} from "@/lib/xero-accepted-quotes.mjs";

export const maxDuration = 60;
const MANUAL_COOLDOWN_MS = 60_000;

export async function POST() {
  const user = await currentUser();
  if (!user || user.role !== "admin")
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  await ensureAuthSchema();
  const client = await pool.connect();
  let locked = false;
  try {
    const state = await client.query(
      "SELECT last_started_at FROM xero_accepted_quote_sync_state WHERE id=true",
    );
    const lastStarted = Date.parse(state.rows[0]?.last_started_at || "");
    if (Number.isFinite(lastStarted) && Date.now() - lastStarted < MANUAL_COOLDOWN_MS)
      return NextResponse.json(
        { error: "Accepted quotes were checked less than a minute ago. Refresh the report instead." },
        { status: 429 },
      );
    const lock = await client.query("SELECT pg_try_advisory_lock(742037) AS locked");
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked)
      return NextResponse.json(
        { error: "An accepted-quote check is already running." },
        { status: 409 },
      );
    await client.query(
      "UPDATE xero_accepted_quote_sync_state SET last_started_at=NOW(), last_error=NULL, updated_at=NOW() WHERE id=true",
    );
    const quotes: unknown[] = [];
    let pages = 0;
    let snapshot: string | undefined;
    let sourceObservedAt: string | undefined;
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({
        Status: "ACCEPTED",
        page: String(page),
        order: "UpdatedDateUTC DESC",
      });
      const response = await xeroAccountingFetch(`/Quotes?${query.toString()}`);
      const payload = await response.json();
      if (!response.ok)
        throw new Error(`Xero Quotes check failed (HTTP ${response.status}).`);
      snapshot = assertHubSnapshot(payload, snapshot);
      sourceObservedAt ||= payload._hub.observed_at;
      if (page > 1000) throw new Error("Complete quote collection exceeds page limit");
      const pageQuotes = Array.isArray(payload.Quotes) ? payload.Quotes : [];
      quotes.push(...pageQuotes);
      pages = page;
      if (pageQuotes.length < 100) break;
    }
    const stats = await replaceAcceptedQuoteSnapshot(client, quotes, {
      reservationDays: acceptedQuoteReservationDays(),
      sourceObservedAt,
    });
    return NextResponse.json({ ok: true, ...stats, pages });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to check accepted quotes.";
    await client.query(
      "UPDATE xero_accepted_quote_sync_state SET last_error=$1, updated_at=NOW() WHERE id=true",
      [message],
    ).catch(() => {});
    console.error("Accepted quote sync error:", error);
    return NextResponse.json({ error: message }, { status: 502 });
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(742037)");
    client.release();
  }
}
