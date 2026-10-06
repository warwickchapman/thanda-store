import assert from 'node:assert/strict';
import pg from 'pg';
import { saveCatalogueEvidence } from '../src/lib/victron-catalogue-review.mjs';
import { refreshReview } from '../src/lib/victron-catalogue-service.mjs';
if (!process.env.DATABASE_URL?.endsWith('/victron_review_test')) throw new Error('Requires isolated victron_review_test database');
const pool = new pg.Pool({connectionString:process.env.DATABASE_URL});
try {
  await pool.query('DROP TABLE IF EXISTS victron_catalogue_evidence,victron_catalogue_review,victron_catalogue_events,victron_sku_successions');
  await pool.query('CREATE TABLE victron_sku_successions(predecessor_sku text,successor_sku text)');
  await pool.query("INSERT INTO victron_sku_successions VALUES('PMP482305010','PMP482305012')");
  const observedAt=new Date().toISOString();
  const product={sku:'PMP482305012',description:'Victron MultiPlus',currency:'ZAR',price:525,enduser_price_zar:{price:1000}};
  await saveCatalogueEvidence(pool,[product],observedAt);
  const request=async company=>Response.json({Items:[],_hub:{complete:true,company,snapshot:'1',observed_at:observedAt}});
  const first=await refreshReview(pool,request); assert.equal(first.rows.length,2);
  await pool.query('UPDATE victron_catalogue_review SET acknowledged_signature=signature');
  await refreshReview(pool,request);
  let state=(await pool.query('SELECT * FROM victron_catalogue_review')).rows[0];
  assert.equal(state.signature,state.acknowledged_signature);
  await assert.rejects(()=>refreshReview(pool,async()=>Response.json({error:'unavailable'},{status:503})),/unavailable/);
  state=(await pool.query('SELECT * FROM victron_catalogue_review')).rows[0];
  assert.equal(state.rows.length,2); assert.ok(state.error); assert.notEqual(state.signature,state.acknowledged_signature);
  await assert.rejects(()=>saveCatalogueEvidence(pool,[],observedAt),/Incomplete/);
  await refreshReview(pool,request); state=(await pool.query('SELECT * FROM victron_catalogue_review')).rows[0]; assert.equal(state.error,null);
  console.log('Store integration passed: complete snapshots, deduplication, failure retention and recovery.');
} finally { await pool.end(); }
