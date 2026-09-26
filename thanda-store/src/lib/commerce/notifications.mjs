export function deliveryState(event) {
  if (['delivered','opened','clicked'].includes(event)) return 'delivered';
  if (['bounced','failed','complained','suppressed'].includes(event)) return 'failed';
  return 'accepted';
}
export async function runNotifications(pool, { fetcher = fetch, pause = ms => new Promise(r => setTimeout(r,ms)), now = () => Date.now() } = {}) {
  const db = await pool.connect();
  let calls = 0;
  let acquired = false;
  try {
    const lock = await db.query("SELECT pg_try_advisory_lock(hashtext('quote-notification-worker')) AS acquired");
    acquired = lock.rows[0].acquired;
    if (!acquired) return { calls:0 };
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error('Resend is not configured for the notification worker.');
    const deadline = now()+45000;
    while (calls < 20 && now() < deadline) {
      const state = await db.query('SELECT next_allowed_at FROM portal_notification_state WHERE id=true');
      if (state.rows[0]?.next_allowed_at && new Date(state.rows[0].next_allowed_at).getTime()>now()) break;
      const result = await db.query(`SELECT * FROM portal_quote_notifications WHERE state IN ('pending','accepted')
        AND next_attempt_at<=now() ORDER BY next_attempt_at,id LIMIT 1`);
      const job = result.rows[0];
      if (!job) break;
      const sending = job.state === 'pending';
      if (sending && (job.attempts>=5 || (job.first_attempt_at && now()-new Date(job.first_attempt_at).getTime()>23*3600000))) {
        await db.query("UPDATE portal_quote_notifications SET state='unconfirmed',last_error='Automatic retry window ended. Review the provider record before resending.',updated_at=now() WHERE id=$1",[job.id]);
        continue;
      }
      if (!sending && job.status_checks>=3) {
        await db.query("UPDATE portal_quote_notifications SET state='unconfirmed',last_error='Email accepted; delivery could not be confirmed.',updated_at=now() WHERE id=$1",[job.id]);
        continue;
      }
      await db.query(`UPDATE portal_quote_notifications SET attempts=attempts+$2,status_checks=status_checks+$3,
        first_attempt_at=COALESCE(first_attempt_at,now()),next_attempt_at=now()+interval '2 minutes' WHERE id=$1`,[job.id,sending?1:0,sending?0:1]);
      calls++;
      try {
        const response=await fetcher(`https://api.resend.com/emails${sending?'':`/${encodeURIComponent(job.provider_id)}`}`,{
          method:sending?'POST':'GET',signal:AbortSignal.timeout(15000),
          headers:{Authorization:`Bearer ${key}`,...(sending?{'Content-Type':'application/json','Idempotency-Key':`quote-${job.request_id}-${job.audience}`}:{})},
          ...(sending?{body:JSON.stringify(job.email_payload)}:{}),
        });
        const payload=await response.json().catch(()=>({}));
        const observations=Object.fromEntries(['ratelimit-limit','ratelimit-remaining','ratelimit-reset','retry-after','x-resend-daily-quota','x-resend-monthly-quota'].map(h=>[h,response.headers.get(h)]));
        await db.query('UPDATE portal_notification_state SET last_response=$1::jsonb,updated_at=now() WHERE id=true',[JSON.stringify({status:response.status,...observations})]);
        if (!response.ok) {
          // Retain only a bounded provider error name, never echoed credentials,
          // message payloads or full arbitrary upstream response bodies.
          const errorName=String(payload.name || 'provider_error').replace(/[^a-z0-9_-]/gi,'').slice(0,80);
          const permanent=[400,401,403,422].includes(response.status) || (response.status===409 && errorName==='invalid_idempotent_request');
          await db.query('UPDATE portal_quote_notifications SET state=$2,last_error=$3,next_attempt_at=now()+($4 * interval \'1 second\'),updated_at=now() WHERE id=$1',
            [job.id,permanent?(sending?'failed':'unconfirmed'):job.state,`Resend ${response.status}: ${errorName}`,Math.min(3600,60*2**(job.attempts+job.status_checks+1))]);
          if ([429,401,403].includes(response.status)) {
            const quota=/quota/.test(errorName);
            const retry=Number(response.headers.get('retry-after'));
            const retryDate=Date.parse(response.headers.get('retry-after') || '');
            const providerDelay=Number.isFinite(retry)&&retry>0?retry:Number.isFinite(retryDate)?Math.max(0,(retryDate-now())/1000):0;
            const delay=Math.max(providerDelay,quota?86400:response.status===429?60:3600);
            await db.query("UPDATE portal_notification_state SET next_allowed_at=now()+($1*interval '1 second') WHERE id=true",[delay]);
            break;
          }
        } else if (sending) {
          if (typeof payload.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(payload.id)) throw new Error('Unconfirmed provider response');
          await db.query("UPDATE portal_quote_notifications SET state='accepted',provider_id=$2,last_error=NULL,next_attempt_at=now()+interval '1 minute',updated_at=now() WHERE id=$1",[job.id,payload.id]);
        } else {
          const status=deliveryState(payload.last_event);
          await db.query("UPDATE portal_quote_notifications SET state=$2,last_error=$3,next_attempt_at=now()+interval '15 minutes',updated_at=now() WHERE id=$1",[job.id,status,status==='failed'?`Delivery ${String(payload.last_event).slice(0,40)}`:null]);
        }
      } catch {
        await db.query("UPDATE portal_quote_notifications SET last_error='Provider request did not return a confirmed result; retry scheduled.',next_attempt_at=now()+interval '5 minutes',updated_at=now() WHERE id=$1",[job.id]);
      }
      await pause(1000);
    }
    return {calls};
  } finally {
    try { if (acquired) await db.query("SELECT pg_advisory_unlock(hashtext('quote-notification-worker'))"); }
    finally { db.release(); }
  }
}
