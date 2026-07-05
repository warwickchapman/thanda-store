import pool from './db';
import fs from 'fs';
import { parse } from 'csv-parse/sync';

type ProductCsvRecord = Record<string, string>;

export async function syncProductsFromCsv() {
  const csvPath = '/root/renogy-store/renogy_products.csv';
  if (!fs.existsSync(csvPath)) {
    console.error('CSV file not found at:', csvPath);
    return;
  }

  const fileContent = fs.readFileSync(csvPath, 'utf-8');
  const records = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
  }) as ProductCsvRecord[];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Clear existing products for fresh sync
    await client.query('TRUNCATE TABLE products');

    for (const record of records) {
      const query = `
        INSERT INTO products (name, category, price, sku, image_url, details)
        VALUES ($1, $2, $3, $4, $5, $6)
      `;
      const values = [
        record['Product Name'],
        record['Category'],
        record['Dealer Price'],
        record['SKU'],
        record['Image URL'] || '',
        JSON.stringify(record)
      ];
      await client.query(query, values);
    }

    await client.query('COMMIT');
    console.log(`Synced ${records.length} products to database.`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error syncing products:', e);
  } finally {
    client.release();
  }
}
