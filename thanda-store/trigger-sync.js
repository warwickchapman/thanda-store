async function runSync() {
  try {
    const { syncProductsFromCsv } = await import('./src/lib/sync');
    await syncProductsFromCsv();
    console.log('Initial sync complete.');
    process.exit(0);
  } catch (err) {
    console.error('Sync failed:', err);
    process.exit(1);
  }
}

runSync();
