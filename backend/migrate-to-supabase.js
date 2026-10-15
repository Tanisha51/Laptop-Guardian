require('dotenv').config();
const { cloudEnabled, importLocalCollectionIfEmpty } = require('./storage');

async function main() {
  if (!cloudEnabled) {
    console.error('Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to backend/.env first.');
    process.exit(1);
  }
  console.log('Importing local Laptop Guardian records into empty Supabase collections only.');
  console.log('Existing non-empty cloud collections will be left untouched.');
  for (const collection of ['users', 'devices', 'events', 'commands']) {
    const result = await importLocalCollectionIfEmpty(collection);
    console.log(`${collection}: ${result.imported ? `imported ${result.count} record(s)` : `skipped — ${result.reason}`}`);
  }
  console.log('Migration check complete. Local JSON files have not been deleted.');
}
main().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
