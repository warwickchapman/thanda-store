import fs from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {createPool} from './product-sync-lib.mjs';
import {publicManufacturerUrl} from '../src/lib/product-details.mjs';
const entries=JSON.parse(fs.readFileSync(new URL('../data/product-resources.json',import.meta.url),'utf8'));
const write=process.argv.includes('--write');
const pool=createPool();let changed=0;
try {
  for(const row of entries) {
    if(!row.resources.every(r=>r.verifiedAt&&r.source&&publicManufacturerUrl(r.url,row.supplier)))throw new Error('Unreviewed resource entry.');
    const result=await pool.query("SELECT id,details->'publicResources' AS resources FROM products WHERE supplier=$1 AND sku=$2",[row.supplier,row.sku]);
    if(!result.rowCount)continue;
    const merged=[...(result.rows[0].resources||[]).filter(r=>!row.resources.some(n=>n.url===r.url)),...row.resources];
    if(isDeepStrictEqual(merged,result.rows[0].resources))continue;
    changed++;
    if(write)await pool.query("UPDATE products SET details=jsonb_set(details,'{publicResources}',$2::jsonb,true) WHERE id=$1",[result.rows[0].id,JSON.stringify(merged)]);
  }
  console.log(`${write?'Updated':'Would update'} ${changed} products. No external calls.`);
}finally{await pool.end();}
