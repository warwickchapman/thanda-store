import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import pool from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type XeroWebhookEvent = {
  eventCategory?: string;
  eventType?: string;
  resourceId?: string;
  eventDateUtc?: string;
  tenantId?: string;
  [key: string]: unknown;
};

function validSignature(rawBody: Buffer, signature: string | null, webhookKey: string) {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', webhookKey).update(rawBody).digest('base64');
  const supplied = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return supplied.length === expectedBuffer.length && crypto.timingSafeEqual(supplied, expectedBuffer);
}

function supportedEvent(event: XeroWebhookEvent) {
  return ['INVOICE', 'CONTACT'].includes(String(event.eventCategory || '').toUpperCase())
    && ['CREATE', 'UPDATE'].includes(String(event.eventType || '').toUpperCase())
    && Boolean(event.resourceId)
    && Boolean(event.tenantId);
}

export async function POST(request: Request) {
  const webhookKey = process.env.XERO_WEBHOOK_KEY;
  if (!webhookKey) {
    // Do not acknowledge deliveries until the endpoint can verify them.
    return new NextResponse(null, { status: 503 });
  }

  const rawBody = Buffer.from(await request.arrayBuffer());
  if (!validSignature(rawBody, request.headers.get('x-xero-signature'), webhookKey)) {
    return new NextResponse(null, { status: 401 });
  }

  let body: { events?: XeroWebhookEvent[] };
  try {
    body = JSON.parse(rawBody.toString('utf8')) as { events?: XeroWebhookEvent[] };
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  const events = Array.isArray(body.events) ? body.events.filter(supportedEvent) : [];
  if (!events.length) return new NextResponse(null, { status: 200 });

  try {
    // The queue is intentionally the only database work in this request. Xero
    // expects a response within five seconds; its API is called by systemd.
    for (const event of events) {
      const normalized = {
        tenantId: String(event.tenantId),
        eventCategory: String(event.eventCategory).toUpperCase(),
        eventType: String(event.eventType).toUpperCase(),
        resourceId: String(event.resourceId),
        eventDateUtc: String(event.eventDateUtc || ''),
      };
      const eventKey = crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
      await pool.query(`
        INSERT INTO xero_webhook_events
          (event_key, tenant_id, event_category, event_type, resource_id, event_date_utc, payload)
        VALUES ($1, $2, $3, $4, $5, NULLIF($6, '')::timestamptz, $7::jsonb)
        ON CONFLICT (event_key) DO NOTHING
      `, [eventKey, normalized.tenantId, normalized.eventCategory, normalized.eventType, normalized.resourceId, normalized.eventDateUtc, JSON.stringify(event)]);
    }
  } catch (error) {
    // A non-2xx response makes Xero retry; never silently drop an event.
    console.error('Unable to queue verified Xero webhook events', error);
    return new NextResponse(null, { status: 503 });
  }

  return new NextResponse(null, { status: 200 });
}
