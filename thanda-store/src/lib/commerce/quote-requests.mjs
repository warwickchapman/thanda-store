// Durable quote submission and local cache/outbox transaction. Hub owns Xero.
export function validRequestId(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
export function quoteNotificationPayloads(quote, context) {
  const quoteNumber = String(quote.QuoteNumber || quote.QuoteID);
  const reference = String(quote.Reference || '');
  const common = `Company: ${context.companyName}\nQuote: ${quoteNumber}\nReference: ${reference}`;
  return {
    buyer: { from:'Thanda Store <sales@thanda.solar>',to:context.buyerEmail,
      subject:`We received your Thanda Store quote request (${quoteNumber})`,
      text:`Hello,\n\nThank you for your quote request.\n${common}\n\nYou requested:\n${quote.LineItems.map(l=>`- ${l.Quantity} x ${l.Description}${l.ItemCode ? ` (${l.ItemCode})` : ''}`).join('\n')}\n\nThe Thanda sales team will send the final quotation shortly and confirm acceptance with you.\n\nView your request: ${context.baseUrl}/accounts?quote=${encodeURIComponent(quote.QuoteID)}\n\nRegards,\nThanda Sales` },
    sales: { from:'Thanda Store <sales@thanda.solar>',to:context.salesEmail,
      subject:`New Thanda Store quote ${quoteNumber} - ${context.companyName}`,
      text:`A customer submitted a quote request from ${context.source === 'cart' ? 'their cart' : 'a copied quote'}.\n\n${common}\nPortal user: ${context.buyerEmail}\nXero status: ${quote.Status}\n\nReview the quote in Xero and contact the customer.\nNotification status: ${context.baseUrl}/admin/quote-requests` },
  };
}
export async function recordQuoteRequest(pool, user, id, payload, context) {
  if (!validRequestId(id)) throw new Error('A valid quote request ID is required.');
  await pool.query(`INSERT INTO portal_quote_requests(id,user_id,contact_id,source,request_payload,context)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT(id) DO NOTHING`,
  [id,user.id,user.xeroContactId,context.source,JSON.stringify(payload),JSON.stringify(context)]);
}
export async function resumeQuoteRequest(pool, user, id, hubFetch) {
  if (!validRequestId(id)) throw new Error('A valid quote request ID is required.');
  const client = await pool.connect();
  let acquired = false;
  try {
    // Lock one operation, not the whole customer's checkout. Never keep a DB
    // transaction open while the Hub is writing to Xero.
    const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [`quote:${id}`]);
    acquired = lock.rows[0].acquired;
    if (!acquired) throw new Error('This request is already being processed. Retry the same request shortly.');
    const found = await client.query('SELECT * FROM portal_quote_requests WHERE id=$1', [id]);
    const row = found.rows[0];
    if (!row) return null;
    if (Number(row.user_id) !== user.id || row.contact_id !== user.xeroContactId) throw new Error('Quote request not found for your account.');
    if (row.completed_at) return quoteResult(row.quote_payload, id);
    let quote;
    try {
      const response = await hubFetch('/Quotes', {
        method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':`portal-quote:${id}`,'X-Hub-Actor':`portal-user:${user.id}`,'X-Hub-Contact':user.xeroContactId},
        body:JSON.stringify(row.request_payload),
      });
      if (!response.ok) throw new Error(`Quote request awaits confirmation (Hub ${response.status}). Retry this same request; contact sales if it remains unresolved.`);
      const payload = await response.json();
      quote = payload.Quotes?.[0];
      if (!quote?.QuoteID || quote.Contact?.ContactID !== user.xeroContactId || quote.HasErrors || !Array.isArray(quote.LineItems)) throw new Error('The Hub has not confirmed a valid quote. Contact sales with the request reference.');
    } catch(error) {
      await client.query('UPDATE portal_quote_requests SET last_error=$2 WHERE id=$1',[id,error instanceof Error ? error.message : 'Hub outcome unconfirmed']);
      throw error;
    }
    await client.query('BEGIN');
    try {
      await client.query(`UPDATE portal_quote_requests SET quote_id=$2,quote_payload=$3::jsonb,completed_at=now(),last_error=NULL WHERE id=$1`,[id,quote.QuoteID,JSON.stringify(quote)]);
      await cacheCreatedQuote(client,user.xeroContactId,quote);
      for (const [audience,payload] of Object.entries(quoteNotificationPayloads(quote,row.context))) {
        await client.query(`INSERT INTO portal_quote_notifications(request_id,audience,email_payload) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`,[id,audience,JSON.stringify(payload)]);
      }
      // A concurrent cart edit must survive completing an earlier checkout.
      for (const line of row.context.cart || []) await client.query(`DELETE FROM portal_cart_lines WHERE user_id=$1 AND product_id=$2 AND quantity=$3 AND updated_at=$4`,[user.id,line.product_id,line.quantity,line.updated_at]);
      await client.query(`INSERT INTO portal_activity_log(user_id,organisation_id,action,resource_type,resource_id,metadata)
        VALUES($1,$2,'quote_requested','quote',$3,$4::jsonb)`,[user.id,user.organisationId,quote.QuoteID,JSON.stringify({requestId:id,source:row.source,quoteNumber:quote.QuoteNumber})]);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; }
    return quoteResult(quote,id);
  } finally {
    try { if (acquired) await client.query('SELECT pg_advisory_unlock(hashtext($1))',[`quote:${id}`]); }
    finally { client.release(); }
  }
}
function quoteResult(quote,id) {
  return {requestId:id,quoteId:quote.QuoteID,quoteNumber:quote.QuoteNumber,quoteStatus:quote.Status,quoteReference:quote.Reference || '',notificationStatus:'pending',cart:{lines:[],itemCount:0,subtotalExVat:0}};
}
export async function cacheCreatedQuote(db,contactId,quote) {
  await db.query(`INSERT INTO xero_customer_documents(contact_id,document_type,document_id,document_number,status,document_date,reference,currency_code,total,payload,synced_at)
    VALUES($1,'quote',$2,$3,$4,$5,$6,$7,$8,$9::jsonb,now()) ON CONFLICT(contact_id,document_type,document_id)
    DO UPDATE SET document_number=EXCLUDED.document_number,status=EXCLUDED.status,document_date=EXCLUDED.document_date,
      reference=EXCLUDED.reference,currency_code=EXCLUDED.currency_code,total=EXCLUDED.total,payload=EXCLUDED.payload,synced_at=now()`,
  [contactId,quote.QuoteID,quote.QuoteNumber || '',quote.Status,String(quote.DateString || quote.Date || '').slice(0,10).match(/^\d{4}-\d{2}-\d{2}$/)?.[0] || null,quote.Reference || '',quote.CurrencyCode || 'ZAR',Number(quote.Total || 0),JSON.stringify(quote)]);
}
