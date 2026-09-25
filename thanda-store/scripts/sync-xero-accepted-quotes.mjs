#!/usr/bin/env node

import { hubFetch, hubStatus, assertHubSnapshot } from '../src/lib/xero/hub.mjs';

import { createPool } from './product-sync-lib.mjs';
import {
  acceptedQuoteReservationDays,
  ensureAcceptedQuoteSchema,
  replaceAcceptedQuoteSnapshot,
} from '../src/lib/xero-accepted-quotes.mjs';

const QUOTES_URL = '/Quotes';

async function fetchAcceptedQuotes() {
  const quotes = [];
  let snapshot;
  let sourceObservedAt;
  for (let page = 1; page <= 1000; page += 1) {
    const url = new URL(QUOTES_URL, 'http://hub.invalid');
    url.searchParams.set('Status', 'ACCEPTED');
    url.searchParams.set('page', String(page));
    url.searchParams.set('order', 'UpdatedDateUTC DESC');
    const response = await hubFetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: 'application/json',
      },
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(`Xero Quotes fetch failed: ${response.status} ${response.statusText}`);
    snapshot = assertHubSnapshot(payload, snapshot);
    sourceObservedAt ||= payload._hub.observed_at;
    const pageQuotes = Array.isArray(payload.Quotes) ? payload.Quotes : [];
    quotes.push(...pageQuotes);
    if (pageQuotes.length < 100) return { quotes, pages: page, sourceObservedAt };

  }
  throw new Error("Complete quote collection exceeds page limit");
}

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  let locked = false;
  try {
    await ensureAcceptedQuoteSchema(client);
    const lock = await client.query('SELECT pg_try_advisory_lock(742037) AS locked');
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return console.log('Another Xero accepted-quote sync is already running.');
    await client.query("UPDATE xero_accepted_quote_sync_state SET last_started_at=NOW(), last_error=NULL, updated_at=NOW() WHERE id=true");
    const token = await hubStatus();
    if (!token.tenant_id) throw new Error('Xero Hub connection has no tenant identity');
    const fetched = await fetchAcceptedQuotes(client, token);
    const stats = await replaceAcceptedQuoteSnapshot(client, fetched.quotes, {
      reservationDays: acceptedQuoteReservationDays(),
      sourceObservedAt: fetched.sourceObservedAt,
    });
    console.log(JSON.stringify({ ...stats, pages: fetched.pages }, null, 2));
  } catch (error) {
    await client.query(
      "UPDATE xero_accepted_quote_sync_state SET last_error=$1, updated_at=NOW() WHERE id=true",
      [error instanceof Error ? error.message : String(error)],
    ).catch(() => {});
    throw error;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(742037)');
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
