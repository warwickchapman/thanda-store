const pool = require('./thanda-solar/src/lib/db').default;
const fs = require('fs');
const csv = require('csv-parse/sync');

async function sync() {
  const content = fs.readFileSync('master_product_import.csv', 'utf-8');
  const records = csv.parse(content, { columns: true });
  
  console.log('Importing ' + records.length + ' products...');
  
  for (const r of records) {
    try {
      await pool.query(
        'INSERT INTO products (sku, name, price, image_url, category, details, last_updated) ' +
        'VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())',
        [r.sku, r.name, parseFloat(r.price) || 0, r.image_url, r.category, r.details]
      );
    } catch (err) {
      console.error('Error on SKU ' + r.sku + ': ' + err.message);
    }
  }
  console.log('Sync complete!');
  process.exit(0);
}
sync();
