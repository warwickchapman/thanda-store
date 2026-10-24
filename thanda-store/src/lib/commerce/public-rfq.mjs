import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { validCustomerViewOrigin } from '../auth/impersonation-origin.mjs';

export class RfqError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

export function requireRfqOrigin(request) {
  // The browser submits from the Store page, not directly from marketing sites.
  if (!validCustomerViewOrigin(request, { portalBaseUrl: process.env.PORTAL_BASE_URL, nodeEnv: process.env.NODE_ENV })) {
    throw new RfqError(403, 'Open the quote form on Thanda Store and try again.');
  }
}

export async function readRfqJson(request, maxBytes = 16384) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new RfqError(415, 'Send this request as JSON.');
  if (Number(request.headers.get('content-length')) > maxBytes) throw new RfqError(413, 'The request is too large.');
  if (!request.body) throw new RfqError(400, 'The request is empty.');
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new RfqError(413, 'The request is too large.'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid object');
    return body;
  } catch (error) {
    if (error instanceof RfqError) throw error;
    throw new RfqError(400, 'The form could not be read. Please try again.');
  } finally { reader.releaseLock(); }
}

function field(value, name, maxLength, required = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new RfqError(400, `${name} is invalid.`);
  const result = value.trim();
  if ((required && !result) || result.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) {
    throw new RfqError(400, `${name} is required and must be ${maxLength} characters or fewer.`);
  }
  return result;
}

export function normalizeRfqInput(body, { now = Date.now(), checkTiming = true } = {}) {
  if (!uuid(body?.requestId)) throw new RfqError(400, 'Reload the form to get a valid request reference.');
  if (body.website || (checkTiming && (!Number.isFinite(body.startedAt) || now - body.startedAt < 2000 || now - body.startedAt > 86400000))) {
    throw new RfqError(400, 'Please review the form, then submit it again.');
  }
  const source = body.contact || {};
  const contact = {
    name: field(source.name, 'Your name', 120, true), email: field(source.email, 'Email address', 254, true).toLowerCase(),
    phone: field(source.phone, 'Phone number', 40), company: field(source.company, 'Company', 160), town: field(source.town, 'Town or postcode', 120, true),
  };
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(contact.email) || /[\r\n]/.test(contact.email)) throw new RfqError(400, 'Enter a valid email address.');
  if (!['deliver', 'collect', 'discuss'].includes(body.deliveryPreference)) throw new RfqError(400, 'Choose delivery, collection or advice.');
  if (!Array.isArray(body.lines) || body.lines.length > 8) throw new RfqError(400, 'Choose up to eight products.');
  const message = field(body.message, 'Message', 2000, body.lines.length === 0);
  const seen = new Set();
  const lines = body.lines.map(line => {
    if (!Number.isSafeInteger(line?.productId) || !Number.isSafeInteger(line?.quantity) || line.quantity < 1 || line.quantity > 100 || seen.has(line.productId)) {
      throw new RfqError(400, 'Each selected product needs a quantity between 1 and 100.');
    }
    seen.add(line.productId);
    return { productId: line.productId, quantity: line.quantity };
  }).sort((a, b) => a.productId - b.productId);
  return { id: body.requestId.toLowerCase(), contact, deliveryPreference: body.deliveryPreference, message, lines };
}

export function normalizeRfq(body, publicProducts, now = Date.now()) {
  const input = normalizeRfqInput(body, { now });
  const byId = new Map(publicProducts.map(product => [Number(product.id), product]));
  return { ...input, lines: input.lines.map(line => {
    const product = byId.get(line.productId);
    if (!product) throw new RfqError(409, 'A selected product has changed. Reload the form and choose it again.');
    return { productId: product.id, supplier: product.supplier, sku: product.sku, name: product.name, quantity: line.quantity };
  }) };
}

function requestFingerprint(rfq) {
  // The client operation is stable when a product is renamed, hidden or
  // replaced later. Saved snapshots remain the original sales evidence.
  return digest(JSON.stringify({ contact: rfq.contact,
    lines: rfq.lines.map(line => ({ productId: line.productId, quantity: line.quantity })).sort((a, b) => a.productId - b.productId),
    deliveryPreference: rfq.deliveryPreference, message: rfq.message }));
}

export async function resumePublicRfq(pool, input) {
  const prior = await pool.query('SELECT payload_hash FROM guest_quote_requests WHERE id=$1', [input.id]);
  if (!prior.rowCount) return null;
  if (prior.rows[0].payload_hash !== requestFingerprint(input)) throw new RfqError(409, 'This reference was already submitted. Start a new enquiry for different details.');
  return { reference: input.id, status: 'received' };
}

export function rfqClientKey(request) {
  // Enable only behind a reverse proxy that OVERWRITES X-Real-IP. Otherwise all
  // anonymous traffic shares a conservative bucket; forwarded headers are ignored.
  const supplied = process.env.PUBLIC_RFQ_TRUST_PROXY === '1' ? request.headers.get('x-real-ip')?.trim() : '';
  return digest(supplied && isIP(supplied) ? supplied : 'unattributed');
}

const schemaReady = new WeakMap();
export async function ensurePublicRfqSchema(pool) {
  if (!schemaReady.has(pool)) {
    const pending = createPublicRfqSchema(pool).catch(error => { schemaReady.delete(pool); throw error; });
    schemaReady.set(pool, pending);
  }
  return schemaReady.get(pool);
}

async function createPublicRfqSchema(pool) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('guest-quote-schema-v1'))");
    await db.query(`CREATE TABLE IF NOT EXISTS guest_quote_requests (
    id UUID PRIMARY KEY, payload_hash TEXT NOT NULL, contact JSONB NOT NULL, lines JSONB NOT NULL,
    delivery_preference TEXT NOT NULL, message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','in_review','quoted','closed')),
    notes TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by BIGINT
  );
  CREATE TABLE IF NOT EXISTS guest_quote_rate_limits (
    bucket TEXT PRIMARY KEY, window_start TIMESTAMPTZ NOT NULL, requests INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS guest_quote_notifications (
    id BIGSERIAL PRIMARY KEY, request_id UUID NOT NULL REFERENCES guest_quote_requests(id),
    audience TEXT NOT NULL DEFAULT 'sales' CHECK(audience='sales'), email_payload JSONB NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, provider_id TEXT,
    last_error TEXT, first_attempt_at TIMESTAMPTZ, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status_checks INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(request_id,audience)
  );
  CREATE TABLE IF NOT EXISTS portal_notification_state (
    id BOOLEAN PRIMARY KEY DEFAULT true CHECK(id), next_allowed_at TIMESTAMPTZ,
    last_response JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  INSERT INTO portal_notification_state(id) VALUES(true) ON CONFLICT DO NOTHING;`);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

function salesNotification(rfq) {
  return { from: 'Thanda Store <sales@thanda.solar>', to: process.env.SALES_QUOTE_NOTIFICATION_EMAIL || 'sales@thanda.solar',
    subject: `New website quote enquiry ${rfq.id}`,
    text: `New website quote enquiry. Review the customer and products before creating a formal quote.\n\nReference: ${rfq.id}\nName: ${rfq.contact.name}\nEmail: ${rfq.contact.email}\nPhone: ${rfq.contact.phone || 'Not supplied'}\nCompany: ${rfq.contact.company || 'Not supplied'}\nTown: ${rfq.contact.town}\nPreference: ${rfq.deliveryPreference}\n\n${rfq.lines.map(line => `${line.quantity} x ${line.name} (${line.sku})`).join('\n')}\n\nMessage:\n${rfq.message || 'None'}\n\nReview in Store: https://store.thanda.solar/admin/guest-quote-requests\n\nThis is an enquiry, not an order or a confirmed quotation.` };
}

export async function recordPublicRfq(pool, rfq, clientKey) {
  const hash = requestFingerprint(rfq);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['guest-quote-submission']);
    const prior = await db.query('SELECT payload_hash FROM guest_quote_requests WHERE id=$1', [rfq.id]);
    if (prior.rowCount) {
      if (prior.rows[0].payload_hash !== hash) throw new RfqError(409, 'This reference was already submitted. Start a new enquiry for different details.');
      await db.query('COMMIT');
      return { reference: rfq.id, status: 'received' };
    }
    const counters = [[`ip:${clientKey}`, 3600, 10], [`email:${digest(rfq.contact.email)}`, 86400, 5], ['global', 86400, 100]];
    for (const [bucket, seconds, limit] of counters) {
      const result = await db.query(`INSERT INTO guest_quote_rate_limits(bucket,window_start,requests) VALUES($1,now(),1)
        ON CONFLICT(bucket) DO UPDATE SET
          requests=CASE WHEN guest_quote_rate_limits.window_start <= now()-($2 * interval '1 second') THEN 1 ELSE guest_quote_rate_limits.requests+1 END,
          window_start=CASE WHEN guest_quote_rate_limits.window_start <= now()-($2 * interval '1 second') THEN now() ELSE guest_quote_rate_limits.window_start END
        RETURNING requests`, [bucket, seconds]);
      if (result.rows[0].requests > limit) throw new RfqError(429, 'Too many enquiries. Please contact sales@thanda.solar or try again later.');
    }
    await db.query(`INSERT INTO guest_quote_requests(id,payload_hash,contact,lines,delivery_preference,message)
      VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6)`, [rfq.id, hash, JSON.stringify(rfq.contact), JSON.stringify(rfq.lines), rfq.deliveryPreference, rfq.message]);
    await db.query(`INSERT INTO guest_quote_notifications(request_id,audience,email_payload) VALUES($1,'sales',$2::jsonb)`, [rfq.id, JSON.stringify(salesNotification(rfq))]);
    await db.query("DELETE FROM guest_quote_rate_limits WHERE window_start < now()-interval '2 days'");
    await db.query('COMMIT');
    return { reference: rfq.id, status: 'received' };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

export async function listPublicRfqs(pool) {
  const { rows } = await pool.query(`SELECT r.id,r.created_at,r.updated_at,r.status,r.contact,r.lines,r.delivery_preference,r.message,r.notes,
    n.state AS notification_state,n.attempts AS notification_attempts,n.last_error AS notification_error
    FROM guest_quote_requests r LEFT JOIN guest_quote_notifications n ON n.request_id=r.id
    ORDER BY (r.status IN ('new','in_review')) DESC,r.created_at DESC LIMIT 100`);
  return rows;
}

export async function updatePublicRfq(pool, body, actorId) {
  if (!uuid(body?.id) || !['new', 'in_review', 'quoted', 'closed'].includes(body.status)) throw new RfqError(400, 'Choose a valid enquiry and status.');
  const notes = field(body.notes, 'Staff notes', 2000);
  const result = await pool.query('UPDATE guest_quote_requests SET status=$2,notes=$3,updated_at=now(),updated_by=$4 WHERE id=$1 RETURNING id', [body.id, body.status, notes, actorId]);
  if (!result.rowCount) throw new RfqError(404, 'Enquiry not found.');
  return { ok: true };
}
