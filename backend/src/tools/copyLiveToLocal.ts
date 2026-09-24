// Refresh the LOCAL test database with a copy of the LIVE data (live is only read, never changed).
// Reads MONGODB_URI_LIVE and MONGODB_URI_LOCAL from backend/.env.
// Usage: npm run copy-live-to-local
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { MongoClient } from 'mongodb';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const envFile = path.join(root, '.env');
const vars: Record<string, string | undefined> = { ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}), ...process.env };
function target(env: 'live' | 'local') {
  const key = env === 'live' ? 'MONGODB_URI_LIVE' : 'MONGODB_URI_LOCAL';
  const uri = vars[key];
  if (!uri) throw new Error(`${key} missing in backend/.env`);
  return { uri, db: env === 'live' ? 'fms_live' : 'fms_local' };
}

const live = target('live');
const local = target('local');
if (live.uri === local.uri && live.db === local.db) {
  console.error('Local and Live point at the same MongoDB database — refusing to copy.');
  process.exit(1);
}

const src = await MongoClient.connect(live.uri);
const dst = await MongoClient.connect(local.uri);
try {
  const from = src.db(live.db);
  const to = dst.db(local.db);
  for (const { name } of await to.listCollections({}, { nameOnly: true }).toArray()) {
    if (!name.startsWith('system.')) await to.collection(name).drop();
  }
  for (const { name } of await from.listCollections({}, { nameOnly: true }).toArray()) {
    if (name.startsWith('system.') || name === 'import_uploads') continue;
    let batch: any[] = [];
    let n = 0;
    for await (const doc of from.collection(name).find()) {
      batch.push(doc);
      if (batch.length === 500) { await to.collection(name).insertMany(batch, { ordered: false }); n += batch.length; batch = []; }
    }
    if (batch.length) { await to.collection(name).insertMany(batch, { ordered: false }); n += batch.length; }
    console.log(`  ${name.padEnd(22)} ${n}`);
  }
  console.log(`\nLocal test database "${local.db}" refreshed from live "${live.db}". Indexes are rebuilt when the local backend starts.`);
} finally {
  await src.close();
  await dst.close();
}
