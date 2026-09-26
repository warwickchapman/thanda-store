import { currentUser } from '@/lib/auth/server';
import pool from '@/lib/db';
export async function GET() {
  const user=await currentUser();
  if (user?.role!=='admin') return Response.json({error:'Admin access required.'},{status:403});
  const {rows}=await pool.query(`SELECT r.id,r.created_at,r.completed_at,r.quote_id,r.quote_payload->>'QuoteNumber' AS quote_number,
    r.context->>'companyName' AS company,r.context->>'buyerEmail' AS buyer,r.last_error,
    COALESCE(jsonb_agg(jsonb_build_object('audience',n.audience,'state',n.state,'attempts',n.attempts,'providerId',n.provider_id,'error',n.last_error)) FILTER(WHERE n.id IS NOT NULL),'[]'::jsonb) AS notifications
    FROM portal_quote_requests r LEFT JOIN portal_quote_notifications n ON n.request_id=r.id
    GROUP BY r.id ORDER BY (r.completed_at IS NULL OR bool_or(n.state IN ('failed','unconfirmed') OR n.last_error IS NOT NULL)) DESC,r.created_at DESC LIMIT 100`);
  const state=await pool.query('SELECT next_allowed_at,last_response,updated_at FROM portal_notification_state WHERE id=true');
  return Response.json({requests:rows,provider:state.rows[0]},{headers:{'Cache-Control':'no-store'}});
}
