#!/usr/bin/env node

import { createPool, ensureProductSchema, upsertProduct } from './product-sync-lib.mjs';

const pool = createPool();

const placeholders = [
  {
    sku: 'LORA-RS-00120',
    supplier: 'lora',
    supplier_item_id: 'LORA-RS-00120',
    name: 'LoRa RS Gateway',
    category: 'LoRa',
    price: 0,
    image_url: '',
    stock_on_hand: 0,
    details: {
      originalPrice: null,
      recommendedRetailExVat: null,
      recommendedRetailPriceVatMode: 'ex_vat',
      localStockOnHand: 0,
      supplierStockManaged: false,
      productLinePlaceholder: true,
    },
  },
  {
    sku: 'HUBBLE-AM10+',
    supplier: 'hubble',
    supplier_item_id: 'HUBBLE-AM10+',
    name: 'Hubble AM-10+ Lithium Battery',
    category: 'Batteries',
    price: 0,
    image_url: '',
    stock_on_hand: 0,
    details: {
      originalPrice: null,
      recommendedRetailExVat: null,
      recommendedRetailPriceVatMode: 'ex_vat',
      manualAvailability: 'In stock (3-5 days)',
      productLinePlaceholder: true,
      adminAvailabilityTodo: 'Add simple admin control to flip Hubble in-stock/out-of-stock status.',
    },
  },
];

async function applyMetadataRules(client) {
  await client.query(`
    UPDATE products
    SET details = jsonb_set(details, '{hidden}', 'true'::jsonb, true)
    WHERE supplier = 'victron' AND lower(category) = 'solar home system'
  `);

  await client.query(`
    UPDATE products
    SET details = details
      || jsonb_build_object(
        'is120vAc', true,
        'productNotes', jsonb_build_array('Note: 120V AC')
      )
    WHERE supplier = 'victron' AND name ~* '(^|[^0-9])120V([^0-9]|$)'
  `);

  await client.query(`
    UPDATE products
    SET details = details
      || jsonb_build_object(
        'supplierStockLabel', 'Renogy Warehouse ZA',
        'supplierAvailability', 'Availability: 4-7 working days'
      )
    WHERE supplier = 'renogy'
  `);

  await client.query(`
    UPDATE products
    SET details = details
      || jsonb_build_object(
        'supplierStockLabel', 'Victron Warehouse ZA',
        'supplierAvailability', 'Availability: 3-5 working days'
      )
    WHERE supplier = 'victron'
  `);
}

async function main() {
  const client = await pool.connect();
  try {
    await ensureProductSchema(client);
    await applyMetadataRules(client);
    for (const product of placeholders) {
      await upsertProduct(client, product);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
