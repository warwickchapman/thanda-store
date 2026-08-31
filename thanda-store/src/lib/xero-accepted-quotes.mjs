const DEFAULT_RESERVATION_DAYS = 90;

function text(value) {
  return String(value || '').trim();
}

function isoDate(value) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export function acceptedQuoteReservationDays() {
  const configured = Number(process.env.XERO_ACCEPTED_QUOTE_RESERVATION_DAYS);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_RESERVATION_DAYS;
}

export function normalizeAcceptedQuote(quote, { now = new Date(), reservationDays = acceptedQuoteReservationDays() } = {}) {
  const quoteDate = isoDate(quote?.DateString);
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - reservationDays);
  cutoff.setUTCHours(0, 0, 0, 0);
  const rmaText = `${text(quote?.Reference)} ${text(quote?.Contact?.Name)}`;
  const isRma = /\bRMA\b/i.test(rmaText) || /RMA\s*CONTROL/i.test(rmaText);
  const isStale = !quoteDate || new Date(`${quoteDate}T00:00:00Z`) < cutoff;
  const exclusionReason = isRma ? 'rma' : isStale ? 'stale' : null;
  const lines = (Array.isArray(quote?.LineItems) ? quote.LineItems : [])
    .map((line, index) => ({
      lineKey: text(line?.LineItemID) || String(index + 1),
      sku: text(line?.ItemCode).toUpperCase() || null,
      description: text(line?.Description),
      quantity: Number(line?.Quantity),
    }))
    .filter((line) => line.sku && Number.isInteger(line.quantity) && line.quantity > 0);
  return {
    quoteId: text(quote?.QuoteID),
    quoteNumber: text(quote?.QuoteNumber),
    contactId: text(quote?.Contact?.ContactID) || null,
    contactName: text(quote?.Contact?.Name),
    reference: text(quote?.Reference),
    quoteDate,
    expiryDate: isoDate(quote?.ExpiryDateString),
    updatedDateUtc: isoDate(quote?.UpdatedDateUTC),
    reservationEligible: !exclusionReason,
    exclusionReason,
    lines,
  };
}

export async function ensureAcceptedQuoteSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS xero_api_usage (
      id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
      day_limit_remaining INTEGER,
      minute_limit_remaining INTEGER,
      app_minute_limit_remaining INTEGER,
      rate_limit_problem TEXT,
      retry_after_seconds INTEGER,
      next_allowed_at TIMESTAMPTZ,
      source TEXT,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS xero_accepted_quotes (
      quote_id TEXT PRIMARY KEY,
      quote_number TEXT NOT NULL,
      contact_id TEXT,
      contact_name TEXT NOT NULL DEFAULT '',
      reference TEXT NOT NULL DEFAULT '',
      quote_date DATE,
      expiry_date DATE,
      updated_date_utc DATE,
      reservation_eligible BOOLEAN NOT NULL DEFAULT false,
      exclusion_reason TEXT,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS xero_accepted_quote_lines (
      quote_id TEXT NOT NULL REFERENCES xero_accepted_quotes(quote_id) ON DELETE CASCADE,
      line_key TEXT NOT NULL,
      sku TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      PRIMARY KEY (quote_id, line_key)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS xero_accepted_quote_sync_state (
      id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
      last_started_at TIMESTAMPTZ,
      last_successful_sync_at TIMESTAMPTZ,
      last_error TEXT,
      last_stats JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query('INSERT INTO xero_accepted_quote_sync_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING');
  await client.query('CREATE INDEX IF NOT EXISTS xero_accepted_quote_lines_sku_idx ON xero_accepted_quote_lines (sku)');
}

export async function replaceAcceptedQuoteSnapshot(client, rawQuotes, options = {}) {
  const quotes = rawQuotes
    .filter((quote) => String(quote?.Status || '').toUpperCase() === 'ACCEPTED')
    .map((quote) => normalizeAcceptedQuote(quote, options))
    .filter((quote) => quote.quoteId);
  const stats = {
    acceptedQuotes: quotes.length,
    activeQuotes: quotes.filter((quote) => quote.reservationEligible).length,
    rmaExcluded: quotes.filter((quote) => quote.exclusionReason === 'rma').length,
    staleExcluded: quotes.filter((quote) => quote.exclusionReason === 'stale').length,
    reservableLines: quotes.filter((quote) => quote.reservationEligible).reduce((sum, quote) => sum + quote.lines.length, 0),
    reservationDays: options.reservationDays || acceptedQuoteReservationDays(),
  };
  await ensureAcceptedQuoteSchema(client);
  await client.query('BEGIN');
  try {
    await client.query('DELETE FROM xero_accepted_quotes');
    for (const quote of quotes) {
      await client.query(`
        INSERT INTO xero_accepted_quotes (
          quote_id, quote_number, contact_id, contact_name, reference, quote_date,
          expiry_date, updated_date_utc, reservation_eligible, exclusion_reason, synced_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
      `, [quote.quoteId, quote.quoteNumber, quote.contactId, quote.contactName, quote.reference,
        quote.quoteDate, quote.expiryDate, quote.updatedDateUtc, quote.reservationEligible, quote.exclusionReason]);
      for (const line of quote.lines) {
        await client.query(`
          INSERT INTO xero_accepted_quote_lines (quote_id, line_key, sku, description, quantity)
          VALUES ($1,$2,$3,$4,$5)
        `, [quote.quoteId, line.lineKey, line.sku, line.description, line.quantity]);
      }
    }
    await client.query(`
      UPDATE xero_accepted_quote_sync_state
      SET last_successful_sync_at = NOW(), last_error = NULL, last_stats = $1::jsonb, updated_at = NOW()
      WHERE id = true
    `, [JSON.stringify(stats)]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  return stats;
}
