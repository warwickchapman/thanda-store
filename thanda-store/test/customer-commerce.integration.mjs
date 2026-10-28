// Synthetic isolated PostgreSQL schema; no Hub, Resend, supplier or live user writes.
import pg from 'pg';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {ensureCommerceSchema} from '../src/lib/commerce/schema.mjs';
import {newApiKey,authenticateApiKey,consumeApiRate} from '../src/lib/commerce/api-keys.mjs';
import {recordQuoteRequest,resumeQuoteRequest} from '../src/lib/commerce/quote-requests.mjs';
import {runNotifications} from '../src/lib/commerce/notifications.mjs';
if(process.env.RUN_COMMERCE_DB_TESTS!=='1')throw new Error('Set RUN_COMMERCE_DB_TESTS=1 to run in a synthetic isolated database schema.');
const schema=`commerce_test_${crypto.randomBytes(6).toString('hex')}`;
const config={connectionString:process.env.DATABASE_URL,user:process.env.POSTGRES_USER,host:process.env.POSTGRES_HOST||'localhost',database:process.env.POSTGRES_DATABASE,password:process.env.POSTGRES_PASSWORD,port:Number(process.env.POSTGRES_PORT||5432)};
const admin=new pg.Pool(config);let pool;
try {
 await admin.query(`CREATE SCHEMA ${schema}`);
 pool=new pg.Pool({...config,options:`-c search_path=${schema}`});
 await pool.query(`CREATE TABLE organisations(id BIGINT PRIMARY KEY,name TEXT,xero_contact_id TEXT);
 CREATE TABLE portal_users(id BIGINT PRIMARY KEY,organisation_id BIGINT REFERENCES organisations(id),email TEXT DEFAULT 'fixture@example.test',is_active BOOLEAN DEFAULT true,archived_at TIMESTAMPTZ);
 CREATE TABLE user_supplier_discounts(user_id BIGINT,supplier TEXT,discount_percent NUMERIC);
 CREATE TABLE portal_cart_lines(user_id BIGINT,product_id BIGINT,quantity INTEGER,updated_at TIMESTAMPTZ DEFAULT now());
 CREATE TABLE portal_activity_log(user_id BIGINT,organisation_id BIGINT,action TEXT,resource_type TEXT,resource_id TEXT,metadata JSONB);
 CREATE TABLE xero_customer_documents(contact_id TEXT,document_type TEXT,document_id TEXT,document_number TEXT,status TEXT,document_date DATE,reference TEXT,currency_code TEXT,total NUMERIC,payload JSONB,synced_at TIMESTAMPTZ,PRIMARY KEY(contact_id,document_type,document_id));
 INSERT INTO organisations VALUES(1,'Company A','contact-a'),(2,'Company B','contact-b');
 INSERT INTO portal_users(id,organisation_id) VALUES(1,1),(2,1),(3,2);
 INSERT INTO user_supplier_discounts VALUES(1,'victron',30),(2,'victron',30),(3,'victron',20);`);
 await ensureCommerceSchema(pool);await ensureCommerceSchema(pool);
 assert.equal((await pool.query("SELECT discount_percent FROM contact_supplier_discounts WHERE contact_id='contact-a' AND supplier='victron'")).rows[0].discount_percent,'30.00');
 assert.equal((await pool.query("SELECT discount_percent FROM contact_supplier_discounts WHERE contact_id='contact-b' AND supplier='victron'")).rows[0].discount_percent,'20.00');
 // Missing user rates count as defaults; a conflicting explicit price blocks migration.
 await pool.query("DELETE FROM portal_commerce_migrations; UPDATE user_supplier_discounts SET discount_percent=35 WHERE user_id=2");
 await assert.rejects(()=>ensureCommerceSchema(pool),/conflicting/);
 await pool.query('UPDATE user_supplier_discounts SET discount_percent=30 WHERE user_id=2');await ensureCommerceSchema(pool);
 const key=newApiKey();await pool.query("UPDATE portal_users SET api_enabled=true WHERE id=1");
 await pool.query('INSERT INTO portal_api_keys(id,user_id,contact_id,name,token_hash,prefix) VALUES($1,1,\'contact-a\',\'fixture\',$2,$3)',[key.id,key.hash,key.prefix]);
 assert.ok(await authenticateApiKey(pool,`Bearer ${key.token}`));assert.equal(await authenticateApiKey(pool,'Bearer bad'),null);
 await pool.query("UPDATE organisations SET xero_contact_id='other' WHERE id=1");assert.equal(await authenticateApiKey(pool,`Bearer ${key.token}`),null);
 await pool.query("UPDATE organisations SET xero_contact_id='contact-a' WHERE id=1; UPDATE portal_users SET api_enabled=false WHERE id=1");assert.equal(await authenticateApiKey(pool,`Bearer ${key.token}`),null);
 await pool.query("UPDATE portal_users SET api_enabled=true WHERE id=1; UPDATE portal_api_keys SET revoked_at=now()");assert.equal(await authenticateApiKey(pool,`Bearer ${key.token}`),null);
 for(let i=0;i<60;i++)assert.equal(await consumeApiRate(pool,1),true);assert.equal(await consumeApiRate(pool,1),false);
 const user={id:1,organisationId:1,xeroContactId:'contact-a'};const id=crypto.randomUUID();const quote={QuoteID:crypto.randomUUID(),Contact:{ContactID:'contact-a'},QuoteNumber:'Q-test',Status:'DRAFT',DateString:'2026-09-26',Reference:'Test',Total:100,LineItems:[{Quantity:1,Description:'Test product',ItemCode:'TEST'}]};
 await pool.query('INSERT INTO portal_cart_lines(user_id,product_id,quantity) VALUES(1,1,1),(1,2,1)');
 const cart=(await pool.query('SELECT product_id,quantity,updated_at::text FROM portal_cart_lines')).rows;
 const context={source:'cart',cart,companyName:'Example',buyerEmail:'buyer@example.test',salesEmail:'sales@example.test',baseUrl:'https://example.test'};
 await recordQuoteRequest(pool,user,id,{Quotes:[quote]},context);
 // Cart edits after submission survive confirmation.
 await pool.query('UPDATE portal_cart_lines SET quantity=2,updated_at=now() WHERE product_id=2');
 await assert.rejects(()=>resumeQuoteRequest(pool,user,id,async()=>{throw new Error('network timeout');}),/timeout/);
 let hubCalls=0;const hub=async(_path,init)=>{hubCalls++;assert.equal(init.headers['Idempotency-Key'],`portal-quote:${id}`);assert.deepEqual(JSON.parse(init.body),{Quotes:[quote]});return Response.json({Quotes:[quote]});};
 // Simulate failure committing the local cache after the Hub created the quote.
 await pool.query(`CREATE FUNCTION reject_quote_cache() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic cache failure'; END $$;
 CREATE TRIGGER reject_quote_cache BEFORE INSERT ON xero_customer_documents FOR EACH ROW EXECUTE FUNCTION reject_quote_cache()`);
 await assert.rejects(()=>resumeQuoteRequest(pool,user,id,hub),/synthetic cache failure/);
 assert.equal((await pool.query('SELECT count(*)::int n FROM portal_quote_notifications')).rows[0].n,0);
 assert.equal((await pool.query('SELECT completed_at FROM portal_quote_requests WHERE id=$1',[id])).rows[0].completed_at,null);
 await pool.query('DROP TRIGGER reject_quote_cache ON xero_customer_documents');
 const first=await resumeQuoteRequest(pool,user,id,hub);assert.equal(first.quoteId,quote.QuoteID);
 const second=await resumeQuoteRequest(pool,user,id,hub);assert.equal(second.quoteId,quote.QuoteID);assert.equal(hubCalls,2);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM portal_quote_notifications')).rows[0].n,2);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM xero_customer_documents')).rows[0].n,1);
 assert.equal((await pool.query('SELECT product_id FROM portal_cart_lines')).rows[0].product_id,'2');
 await assert.rejects(()=>resumeQuoteRequest(pool,{...user,id:3,xeroContactId:'contact-b'},id,hub),/not found/);
 process.env.RESEND_API_KEY='synthetic-test-key';
 const sends=[];const fetcher=async(url,init)=>{
  assert.ok(url.startsWith('https://api.resend.com/emails'));
  if(init.method==='POST'){sends.push(init.headers['Idempotency-Key']);return Response.json({id:crypto.randomUUID()});}
  return Response.json({last_event:'delivered'});
 };
 await runNotifications(pool,{fetcher,pause:async()=>{}});assert.equal(sends.length,2);
 await pool.query("UPDATE portal_quote_notifications SET next_attempt_at=now()");
 await runNotifications(pool,{fetcher,pause:async()=>{}});assert.equal(sends.length,2);
 assert.equal((await pool.query("SELECT count(*)::int n FROM portal_quote_notifications WHERE state='delivered'")).rows[0].n,2);
 // Provider 429 pauses the global worker; no second recipient is attempted.
 await pool.query("UPDATE portal_quote_notifications SET state='pending',next_attempt_at=now(),provider_id=NULL");
 let rateCalls=0;await runNotifications(pool,{fetcher:async()=>{rateCalls++;return Response.json({name:'rate_limit_exceeded'},{status:429,headers:{'Retry-After':'120'}});},pause:async()=>{}});assert.equal(rateCalls,1);
 await runNotifications(pool,{fetcher:async()=>{throw new Error('must not call during cooldown');},pause:async()=>{}});
 await pool.query("UPDATE portal_notification_state SET next_allowed_at=NULL; UPDATE portal_quote_notifications SET next_attempt_at=now(),first_attempt_at=now()-interval '24 hours'");
 await runNotifications(pool,{fetcher:async()=>{throw new Error('must not send after idempotency window');},pause:async()=>{}});
 assert.equal((await pool.query("SELECT count(*)::int n FROM portal_quote_notifications WHERE state='unconfirmed'")).rows[0].n,2);

 // Completed requests can be missing their mandatory jobs after an operator
 // recovery. Repair that local outbox without repeating quote completion.
 const requestSnapshot=async requestId=>(await pool.query(
  'SELECT to_jsonb(request) AS record FROM portal_quote_requests request WHERE id=$1',[requestId],
 )).rows[0].record;
 const notificationSnapshot=async requestId=>(await pool.query(
  'SELECT to_jsonb(job) AS record FROM portal_quote_notifications job WHERE request_id=$1 ORDER BY audience',[requestId],
 )).rows.map(row=>row.record);
 const sideEffectSnapshot=async()=>{
  const [cartRows,activityRows,documents]=await Promise.all([
   pool.query('SELECT to_jsonb(line) AS record FROM portal_cart_lines line ORDER BY user_id,product_id'),
   pool.query('SELECT to_jsonb(activity) AS record FROM portal_activity_log activity ORDER BY user_id,action,resource_id'),
   pool.query('SELECT to_jsonb(document) AS record FROM xero_customer_documents document ORDER BY contact_id,document_type,document_id'),
  ]);
  return {cart:cartRows.rows,activities:activityRows.rows,documents:documents.rows};
 };
 async function completedFixture(){
  const requestId=crypto.randomUUID();
  const savedQuote={...quote,QuoteID:crypto.randomUUID(),QuoteNumber:`Q-completed-${requestId.slice(0,8)}`,
   Status:'SENT',ValidationErrors:[]};
  // This deliberately matches the surviving, edited cart line. Accidentally
  // replaying normal completion would delete it and fail the snapshot check.
  const currentCart=(await pool.query(
   'SELECT product_id,quantity,updated_at::text FROM portal_cart_lines WHERE user_id=$1 ORDER BY product_id',[user.id],
  )).rows;
  const savedContext={...context,cart:currentCart};
  await recordQuoteRequest(pool,user,requestId,{Quotes:[savedQuote]},savedContext);
  await pool.query(`UPDATE portal_quote_requests SET quote_id=$2,quote_payload=$3::jsonb,completed_at=now()
   WHERE id=$1`,[requestId,savedQuote.QuoteID,JSON.stringify(savedQuote)]);
  return {requestId,savedQuote};
 }
 let completedHubCalls=0;
 const noCompletedHub=async()=>{completedHubCalls++;throw new Error('Completed requests must not call the Hub');};
 const sideEffectsBefore=await sideEffectSnapshot();
 const missingAll=await completedFixture();
 const completedBefore=await requestSnapshot(missingAll.requestId);
 assert.deepEqual(await notificationSnapshot(missingAll.requestId),[]);
 const repaired=await resumeQuoteRequest(pool,user,missingAll.requestId,noCompletedHub);
 assert.equal(repaired.quoteId,missingAll.savedQuote.QuoteID);
 const repairedJobs=await notificationSnapshot(missingAll.requestId);
 assert.deepEqual(repairedJobs.map(job=>job.audience),['buyer','sales']);
 assert.deepEqual(repairedJobs.map(job=>job.email_payload.to),[context.buyerEmail,context.salesEmail]);
 assert.ok(repairedJobs.every(job=>job.state==='pending'&&job.attempts===0&&job.provider_id===null));
 assert.ok(repairedJobs.every(job=>job.email_payload.subject.includes(missingAll.savedQuote.QuoteNumber)));
 await resumeQuoteRequest(pool,user,missingAll.requestId,noCompletedHub);
 await resumeQuoteRequest(pool,user,missingAll.requestId,noCompletedHub);
 assert.deepEqual(await notificationSnapshot(missingAll.requestId),repairedJobs,
  'repeated completed resumes must preserve immutable jobs, including their timestamps');
 assert.deepEqual(await requestSnapshot(missingAll.requestId),completedBefore,
  'notification repair must preserve the completed request, original payload and context');

 // A missing audience is repaired independently of the other audience's
 // delivery state. Existing payloads and provider history are never replaced.
 for(const state of ['delivered','failed','unconfirmed','pending','accepted']){
  const fixture=await completedFixture();
  const savedPayload={from:'Recorded sender <recorded@example.test>',to:'recorded-buyer@example.test',
   subject:`Immutable ${state} receipt`,text:'Saved provider request body'};
  await pool.query(`INSERT INTO portal_quote_notifications
   (request_id,audience,email_payload,state,attempts,provider_id,last_error,first_attempt_at,next_attempt_at,status_checks,updated_at)
   VALUES($1,'buyer',$2::jsonb,$3,3,$4,'Preserved provider history',
    '2026-09-26T10:00:00Z','2026-09-27T10:00:00Z',2,'2026-09-26T11:00:00Z')`,
  [fixture.requestId,JSON.stringify(savedPayload),state,crypto.randomUUID()]);
  const [existingBuyer]=await notificationSnapshot(fixture.requestId);
  const savedRequest=await requestSnapshot(fixture.requestId);
  await resumeQuoteRequest(pool,user,fixture.requestId,noCompletedHub);
  const jobs=await notificationSnapshot(fixture.requestId);
  assert.equal(jobs.length,2,`${state}: insert only the missing sales job`);
  assert.deepEqual(jobs.find(job=>job.audience==='buyer'),existingBuyer,`${state}: preserve the existing job exactly`);
  const sales=jobs.find(job=>job.audience==='sales');
  assert.equal(sales.state,'pending');assert.equal(sales.attempts,0);assert.equal(sales.provider_id,null);
  assert.equal(sales.email_payload.to,context.salesEmail);
  await resumeQuoteRequest(pool,user,fixture.requestId,noCompletedHub);
  assert.deepEqual(await notificationSnapshot(fixture.requestId),jobs,`${state}: repeated repair must be idempotent`);
  assert.deepEqual(await requestSnapshot(fixture.requestId),savedRequest);
 }

 // A real PostgreSQL failure inserting the second audience must roll back
 // the first insert, leaving the saved completion and current cart untouched.
 const rejectedOutbox=await completedFixture();
 const rejectedRequest=await requestSnapshot(rejectedOutbox.requestId);
 await pool.query(`CREATE FUNCTION reject_completed_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
   IF NEW.request_id=TG_ARGV[0]::uuid AND NEW.audience='sales' THEN
    RAISE EXCEPTION 'synthetic completed outbox failure';
   END IF;
   RETURN NEW;
  END $$;
  CREATE TRIGGER reject_completed_outbox BEFORE INSERT ON portal_quote_notifications
  FOR EACH ROW EXECUTE FUNCTION reject_completed_outbox('${rejectedOutbox.requestId}')`);
 await assert.rejects(()=>resumeQuoteRequest(pool,user,rejectedOutbox.requestId,noCompletedHub),/synthetic completed outbox failure/);
 assert.deepEqual(await notificationSnapshot(rejectedOutbox.requestId),[],'buyer insert must roll back with failed sales insert');
 assert.deepEqual(await requestSnapshot(rejectedOutbox.requestId),rejectedRequest);
 await pool.query('DROP TRIGGER reject_completed_outbox ON portal_quote_notifications; DROP FUNCTION reject_completed_outbox()');
 await resumeQuoteRequest(pool,user,rejectedOutbox.requestId,noCompletedHub);
 assert.equal((await notificationSnapshot(rejectedOutbox.requestId)).length,2,'the same completed request can repair after rollback');

 for(const invalid of [
  ()=>({payload:null}),
  saved=>({payload:{...saved,QuoteID:crypto.randomUUID()}}),
  saved=>({payload:{...saved,Contact:{ContactID:'contact-b'}}}),
  saved=>({payload:{...saved,HasErrors:true}}),
  saved=>({payload:{...saved,LineItems:null}}),
  saved=>({payload:{...saved,ValidationErrors:[{Message:'Synthetic Xero validation error'}]}}),
  saved=>({payload:saved,quoteId:null}),
 ]){
  const fixture=await completedFixture();
  const patch=invalid(fixture.savedQuote);
  await pool.query('UPDATE portal_quote_requests SET quote_payload=$2::jsonb,quote_id=$3 WHERE id=$1',
   [fixture.requestId,JSON.stringify(patch.payload),Object.hasOwn(patch,'quoteId')?patch.quoteId:fixture.savedQuote.QuoteID]);
  const invalidBefore=await requestSnapshot(fixture.requestId);
  await assert.rejects(()=>resumeQuoteRequest(pool,user,fixture.requestId,noCompletedHub),/saved quote needs review/);
  assert.deepEqual(await notificationSnapshot(fixture.requestId),[],'unconfirmed saved quotes must not queue email');
  assert.deepEqual(await requestSnapshot(fixture.requestId),invalidBefore);
 }
 assert.equal(completedHubCalls,0,'all completed-request reconciliation must remain local');
 assert.deepEqual(await sideEffectSnapshot(),sideEffectsBefore,
  'completed resumes must not replay cart deletion, quote cache publication or activity events');
 console.log('PASS: pricing migration/conflicts, key ownership/revocation/rate limit, durable quote retry, atomic cache/outbox/cart, email delivery and cooldown/idempotency window, completed outbox repair/idempotency/history/rollback/validation.');
} finally {if(pool)await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
