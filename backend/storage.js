const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILES = {
  users: path.join(DATA_DIR, 'users.json'),
  devices: path.join(DATA_DIR, 'devices.json'),
  events: path.join(DATA_DIR, 'events.json'),
  commands: path.join(DATA_DIR, 'commands.json')
};
const COLLECTIONS = new Set(Object.keys(FILES));
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const cloudEnabled = Boolean(SUPABASE_URL && SUPABASE_KEY);

fs.mkdirSync(DATA_DIR, { recursive: true });
for (const file of Object.values(FILES)) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]', { encoding: 'utf8', mode: 0o600 });
}

function localRead(collection) {
  if (!COLLECTIONS.has(collection)) throw new Error(`Unknown collection: ${collection}`);
  const value = JSON.parse(fs.readFileSync(FILES[collection], 'utf8'));
  if (!Array.isArray(value)) throw new Error(`${path.basename(FILES[collection])} must contain an array.`);
  return value;
}
function localWrite(collection, records) {
  const file = FILES[collection];
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(records, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

async function supabaseRequest(route, options = {}) {
  if (!cloudEnabled) throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env.');
  const response = await fetch(`${SUPABASE_URL}/rest/v1${route}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const bodyText = await response.text();
  let body = null;
  try { body = bodyText ? JSON.parse(bodyText) : null; } catch { body = bodyText; }
  if (!response.ok) {
    const message = typeof body === 'object' && body ? (body.message || body.error || body.hint) : body;
    throw new Error(`Supabase request failed (${response.status}): ${message || response.statusText}`);
  }
  return body;
}

async function readCollection(collection) {
  if (!COLLECTIONS.has(collection)) throw new Error(`Unknown collection: ${collection}`);
  if (!cloudEnabled) return localRead(collection);
  const rows = await supabaseRequest(`/lg_records?collection=eq.${encodeURIComponent(collection)}&select=record_id,payload&order=record_id.asc`);
  const records = (rows || []).map((row) => row.payload);
  // Protect local data if someone starts the cloud build before running the migration.
  if (records.length === 0) {
    const localRecords = localRead(collection);
    if (localRecords.length > 0) {
      throw new Error(`Supabase collection "${collection}" is empty while local backup has ${localRecords.length} record(s). Run "npm.cmd run migrate:supabase" from backend before starting the server; local data was preserved.`);
    }
  }
  // Keep a local mirror for backup/troubleshooting; cloud remains the source of truth in cloud mode.
  localWrite(collection, records);
  return records;
}

async function replaceCollection(collection, records) {
  if (!COLLECTIONS.has(collection)) throw new Error(`Unknown collection: ${collection}`);
  if (!Array.isArray(records)) throw new Error(`${collection} must be an array.`);
  // Always update the local backup first. If cloud mode is enabled, only report success after cloud persistence.
  localWrite(collection, records);
  if (!cloudEnabled) return;
  await supabaseRequest('/rpc/lg_replace_collection', {
    method: 'POST',
    body: JSON.stringify({ p_collection: collection, p_records: records })
  });
}

async function getCloudCollectionCount(collection) {
  const rows = await supabaseRequest(`/lg_records?collection=eq.${encodeURIComponent(collection)}&select=record_id`);
  return Array.isArray(rows) ? rows.length : 0;
}

async function importLocalCollectionIfEmpty(collection) {
  const count = await getCloudCollectionCount(collection);
  if (count > 0) return { collection, imported: false, reason: `Cloud already has ${count} record(s)` };
  const records = localRead(collection);
  if (!records.length) return { collection, imported: false, reason: 'Local collection is empty' };
  await replaceCollection(collection, records);
  return { collection, imported: true, count: records.length };
}

module.exports = {
  cloudEnabled,
  readCollection,
  replaceCollection,
  localRead,
  importLocalCollectionIfEmpty,
  supabaseRequest
};
