#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import { createPool } from './product-sync-lib.mjs';
import {
  acceptedQuoteReservationDays,
  ensureAcceptedQuoteSchema,
  replaceAcceptedQuoteSnapshot,
} from '../src/lib/xero-accepted-quotes.mjs';

const TOKEN_URL = 'https://identity.xero.com/connect/token';
const QUOTES_URL = 'https://api.xero.com/api.xro/2.0/Quotes';
const DEFAULT_TOKEN_FILE = '/var/lib/thanda-store/xero-token.json';
const DAILY_API_RESERVE = 150;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function readToken(tokenFile) {
  return JSON.parse(await fs.readFile(tokenFile, 'utf8'));
}

async function writeToken(tokenFile, token) {
  await fs.mkdir(path.dirname(tokenFile), { recursive: true });
  await fs.writeFile(tokenFile, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
}

async function refreshTokenIfNeeded(config, token) {
  const expiresAt = token.expires_at ? Date.parse(token.expires_at) : 0;
  if (token.access_token && expiresAt > Date.now() + 60_000) return token;
  if (!token.refresh_token) throw new Error('Xero token file does not contain a refresh_token');
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Xero token refresh failed: ${response.status} ${payload.error || ''}`.trim());
  const updated = {
    ...token,
    ...payload,
    expires_at: new Date(Date.now() + Number(payload.expires_in || 0) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  await writeToken(config.tokenFile, updated);
  return updated;
}

function headerNumber(headers, name) {
  const value = Number(headers.get(name));
  return Number.isFinite(value) ? value : null;
}

async function recordUsage(client, response) {
  const retryAfter = headerNumber(response.headers, 'retry-after');
  const problem = response.headers.get('x-rate-limit-problem');
  await client.query(`
    INSERT INTO xero_api_usage (id, day_limit_remaining, minute_limit_remaining,
      app_minute_limit_remaining, rate_limit_problem, retry_after_seconds,
      next_allowed_at, source, observed_at)
    VALUES (true,$1,$2,$3,$4,$5,$6,'accepted-quotes-sync',NOW())
    ON CONFLICT (id) DO UPDATE SET
      day_limit_remaining=EXCLUDED.day_limit_remaining,
      minute_limit_remaining=EXCLUDED.minute_limit_remaining,
      app_minute_limit_remaining=EXCLUDED.app_minute_limit_remaining,
      rate_limit_problem=EXCLUDED.rate_limit_problem,
      retry_after_seconds=EXCLUDED.retry_after_seconds,
      next_allowed_at=EXCLUDED.next_allowed_at,
      source=EXCLUDED.source, observed_at=EXCLUDED.observed_at
  `, [
    headerNumber(response.headers, 'x-daylimit-remaining'),
    headerNumber(response.headers, 'x-minlimit-remaining'),
    headerNumber(response.headers, 'x-appminlimit-remaining'),
    problem,
    retryAfter,
    problem === 'day' && retryAfter ? new Date(Date.now() + retryAfter * 1000).toISOString() : null,
  ]);
}

async function fetchAcceptedQuotes(client, token) {
  const quotes = [];
  for (let page = 1; ; page += 1) {
    const url = new URL(QUOTES_URL);
    url.searchParams.set('Status', 'ACCEPTED');
    url.searchParams.set('page', String(page));
    url.searchParams.set('order', 'UpdatedDateUTC DESC');
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'xero-tenant-id': token.tenant_id,
        Accept: 'application/json',
      },
    });
    await recordUsage(client, response);
    const payload = await response.json();
    if (!response.ok) throw new Error(`Xero Quotes fetch failed: ${response.status} ${response.statusText}`);
    const pageQuotes = Array.isArray(payload.Quotes) ? payload.Quotes : [];
    quotes.push(...pageQuotes);
    if (pageQuotes.length < 100) return { quotes, pages: page };
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
}

async function main() {
  const config = {
    clientId: requiredEnv('XERO_CLIENT_ID'),
    clientSecret: requiredEnv('XERO_CLIENT_SECRET'),
    tokenFile: process.env.XERO_TOKEN_FILE || DEFAULT_TOKEN_FILE,
  };
  const pool = createPool();
  const client = await pool.connect();
  let locked = false;
  try {
    await ensureAcceptedQuoteSchema(client);
    const lock = await client.query('SELECT pg_try_advisory_lock(742037) AS locked');
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return console.log('Another Xero accepted-quote sync is already running.');
    const usage = await client.query('SELECT day_limit_remaining, next_allowed_at FROM xero_api_usage WHERE id = true');
    const remaining = Number(usage.rows[0]?.day_limit_remaining);
    const nextAllowedAt = Date.parse(usage.rows[0]?.next_allowed_at || '');
    if (Number.isFinite(nextAllowedAt) && nextAllowedAt > Date.now())
      return console.log(`Xero accepted-quote sync paused until ${new Date(nextAllowedAt).toISOString()}.`);
    if (Number.isFinite(remaining) && remaining <= DAILY_API_RESERVE)
      return console.log(`Xero accepted-quote sync paused to retain the ${DAILY_API_RESERVE}-call daily reserve.`);
    await client.query("UPDATE xero_accepted_quote_sync_state SET last_started_at=NOW(), last_error=NULL, updated_at=NOW() WHERE id=true");
    let token = await readToken(config.tokenFile);
    token = await refreshTokenIfNeeded(config, token);
    if (!token.tenant_id) throw new Error('Xero token file does not contain tenant_id');
    const fetched = await fetchAcceptedQuotes(client, token);
    const stats = await replaceAcceptedQuoteSnapshot(client, fetched.quotes, {
      reservationDays: acceptedQuoteReservationDays(),
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
