import {createPool} from './product-sync-lib.mjs';
import {ensureCommerceSchema} from '../src/lib/commerce/schema.mjs';
const pool=createPool();
const write=process.argv.includes('--write');
try {await ensureCommerceSchema(pool,{dryRun:!write});console.log(write?'Company pricing and customer commerce schema ready. No external requests.':'Migration validated and rolled back. Use --write to apply. No external requests.');}
finally {await pool.end();}
