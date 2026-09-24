// Refresh the LOCAL test database with a copy of the LIVE data (live is only read, never changed).
// Usage: npm run copy-live-to-local        (stop the local backend first; live may keep running)
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const liveDir = path.join(root, 'data', 'live');
const localDir = path.join(root, 'data', 'local');
const liveDb = path.join(liveDir, 'fms.db');
const localDb = path.join(localDir, 'fms.db');

if (!existsSync(liveDb)) {
  console.error(`No live database found at ${liveDb}`);
  process.exit(1);
}
mkdirSync(localDir, { recursive: true });
try {
  for (const f of ['fms.db', 'fms.db-wal', 'fms.db-shm']) rmSync(path.join(localDir, f), { force: true });
} catch {
  console.error('The local database is in use. Stop the LOCAL backend (npm start) and try again.');
  process.exit(1);
}

// VACUUM INTO takes a consistent snapshot even while the live backend is running.
const src = new DatabaseSync(liveDb, { readOnly: true });
src.exec(`VACUUM INTO '${localDb.replace(/'/g, "''")}'`);
src.close();

const liveUploads = path.join(liveDir, 'uploads');
const localUploads = path.join(localDir, 'uploads');
rmSync(localUploads, { recursive: true, force: true });
if (existsSync(liveUploads)) cpSync(liveUploads, localUploads, { recursive: true });
else mkdirSync(localUploads, { recursive: true });

console.log(`Local test database refreshed from live:\n  ${liveDb}\n  → ${localDb}`);
console.log('Local keeps its own login secret, so sign in again on the local app.');
