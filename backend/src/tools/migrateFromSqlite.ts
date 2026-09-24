// One-time move of the old SQLite data (backend/data/<env>/fms.db + uploads/) into MongoDB.
// Usage: npm run migrate:sqlite        (Local  → MONGODB_URI in backend/.env.local)
//        npm run migrate:sqlite:live   (Live   → MONGODB_URI in backend/.env.live)
// Add --force to replace data already in the target MongoDB database.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';
import { col, connect, disconnect, files } from '../db/mongo.ts';
import { storeFile } from '../services/attachments.ts';
import { loadStageDefs } from '../services/stageDefs.ts';

const force = process.argv.includes('--force');
const sqliteFile = path.join(config.serverRoot, 'data', config.env, 'fms.db');
const uploadsDir = path.join(config.serverRoot, 'data', config.env, 'uploads');
if (!existsSync(sqliteFile)) {
  console.error(`No SQLite database found at ${sqliteFile}`);
  process.exit(1);
}

const sql = new DatabaseSync(sqliteFile, { readOnly: true });
const rows = (q: string) => sql.prepare(q).all() as Record<string, any>[];
const json = (v: unknown) => (typeof v === 'string' && v ? JSON.parse(v) : null);
const bool = (v: unknown) => !!v;

await connect();
console.log(`Migrating ${sqliteFile}\n  → MongoDB database "${config.mongoDb}" (${config.env.toUpperCase()})`);
if (!force && ((await col.requests().countDocuments()) > 0 || (await col.users().countDocuments()) > 1)) {
  console.error('The target MongoDB database already has data. Re-run with --force to replace it.');
  await disconnect();
  process.exit(1);
}

const all = [col.users, col.properties, col.categories, col.engineers, col.closureCategories, col.workflowStages, col.requests,
  col.events, col.attachments, col.legacyRows, col.batches, col.issues, col.counters];
for (const c of all) await c().deleteMany({});
try { await files().drop(); } catch { /* no photos stored yet */ }

const insert = async (name: string, c: () => any, docs: Record<string, any>[]) => {
  for (let i = 0; i < docs.length; i += 500) await c().insertMany(docs.slice(i, i + 500), { ordered: false });
  console.log(`  ${name.padEnd(20)} ${docs.length}`);
};

await insert('users', col.users, rows('SELECT * FROM users').map(({ id, ...u }) => ({ _id: id, ...u, email: u.email ? String(u.email).toLowerCase() : null })));
await insert('properties', col.properties, rows('SELECT * FROM properties').map(({ id, ...r }) => ({ _id: id, ...r })));
await insert('work_categories', col.categories, rows('SELECT * FROM work_categories').map(({ id, ...r }) => ({ _id: id, ...r })));
await insert('engineers', col.engineers, rows('SELECT * FROM engineers').map(({ id, ...r }) => ({ _id: id, ...r })));
await insert('closure_categories', col.closureCategories, rows('SELECT * FROM closure_categories').map(({ id, ...r }) => ({ _id: id, ...r })));
await insert('workflow_stages', col.workflowStages, rows('SELECT * FROM workflow_stages').map(({ key, ...r }) => ({
  _id: key, ...r, action_roles: json(r.action_roles), sla_rule: json(r.sla_rule), requires_evidence: bool(r.requires_evidence),
  optional: bool(r.optional), decision: bool(r.decision),
})));

const stagesByRequest = new Map<number, Record<string, any>[]>();
for (const { id: _i, request_id, ...s } of rows('SELECT * FROM request_stages ORDER BY request_id, seq')) {
  const list = stagesByRequest.get(request_id) ?? [];
  list.push({ ...s, legacy: json(s.legacy), planned_inferred: bool(s.planned_inferred), actual_inferred: bool(s.actual_inferred) });
  stagesByRequest.set(request_id, list);
}
await insert('requests', col.requests, rows('SELECT * FROM requests').map(({ id, ...r }) => ({
  _id: id, ...r, modified_in_app: bool(r.modified_in_app), version: 1, stages: stagesByRequest.get(id) ?? [],
})));
await insert('request_events', col.events, rows('SELECT * FROM request_events').map(({ id, ...e }) => ({ _id: id, ...e, data: json(e.data) })));

const attachments: Record<string, any>[] = [];
let filesMoved = 0;
let filesMissing = 0;
for (const { id, stored_name, ...a } of rows('SELECT * FROM attachments')) {
  const doc: Record<string, any> = { _id: id, ...a };
  if (a.kind === 'file' && stored_name) {
    const p = path.join(uploadsDir, path.basename(stored_name));
    if (existsSync(p)) {
      doc.file_id = await storeFile({ originalname: a.file_name ?? stored_name, mimetype: a.mime ?? 'application/octet-stream', size: a.size ?? 0, buffer: readFileSync(p) });
      filesMoved++;
    } else filesMissing++;
  }
  attachments.push(doc);
}
await insert('attachments', col.attachments, attachments);
console.log(`  ${'photos → GridFS'.padEnd(20)} ${filesMoved}${filesMissing ? `  (${filesMissing} file(s) missing on disk)` : ''}`);
await insert('legacy_rows', col.legacyRows, rows('SELECT * FROM legacy_rows').map(({ id: _i, ...l }) => ({ _id: l.request_id, ...l, cells: json(l.cells) })));
await insert('import_batches', col.batches, rows('SELECT * FROM import_batches').map(({ id, ...b }) => ({
  _id: id, ...b, options: json(b.options), mapping: json(b.mapping), columns: json(b.columns), summary: json(b.summary),
})));
await insert('import_issues', col.issues, rows('SELECT * FROM import_issues').map(({ id, ...i }) => ({ _id: id, ...i })));

// Counters: job card numbers per year + next ids per collection.
const counters: { _id: string; seq: number }[] = rows('SELECT name, value FROM sequences')
  .filter((s) => String(s.name).startsWith('jobcard-')).map((s) => ({ _id: s.name, seq: s.value }));
const idTables: [string, string][] = [['users', 'users'], ['properties', 'properties'], ['work_categories', 'work_categories'], ['engineers', 'engineers'],
  ['closure_categories', 'closure_categories'], ['requests', 'requests'], ['request_events', 'request_events'], ['attachments', 'attachments'],
  ['import_batches', 'import_batches'], ['import_issues', 'import_issues']];
for (const [table, name] of idTables) {
  const max = (sql.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get() as { m: number }).m;
  counters.push({ _id: `id:${name}`, seq: max });
}
await col.counters().insertMany(counters);
await loadStageDefs();
sql.close();
console.log('\nDone. The old SQLite files were only read — they are unchanged and can be kept as a backup.');
await disconnect();
