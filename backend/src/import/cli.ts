// Usage: npm run import:cli -- "<file.tsv>" [--commit] [--update] [--no-infer]   (import:cli:live for the live database)
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AuthUser } from '../auth/auth.ts';
import { config } from '../config.ts';
import { col, connect, disconnect } from '../db/mongo.ts';
import { ensureBaseData } from '../db/seed.ts';
import { commitImport, preview, saveUpload, validateImport } from './importService.ts';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: import:cli -- <file.tsv> [--commit] [--update] [--no-infer]');
  process.exit(1);
}
await connect();
await ensureBaseData();
console.log(`Environment: ${config.env.toUpperCase()}  (MongoDB database "${config.mongoDb}")`);
const admin = await col.users().findOne({ role: 'admin', active: 1 }, { sort: { _id: 1 } });
if (!admin) throw new Error('No active administrator found');
const user: AuthUser = { id: admin._id, username: admin.username, name: admin.name, role: 'admin', engineer_id: null, must_change_password: false };

const up = await saveUpload({ buffer: readFileSync(file), originalname: path.basename(file), size: statSync(file).size }, user);
const p = await preview(up.upload_id, user);
console.log(`Layout: ${p.layout.format}, header row ${p.layout.header_row + 1}, ${p.layout.data_rows} data rows, export at ${p.layout.export_at}`);
for (const c of p.layout.columns) console.log(`  ${c.letter.padEnd(3)} ${(c.group || '').padEnd(34).slice(0, 34)} ${(c.header || '(blank)').padEnd(30).slice(0, 30)} → ${p.mapping[String(c.index)] || '(ignored)'}`);

const body = { mapping: p.mapping, options: { mode: args.includes('--update') ? 'update' : 'skip', infer_planned: !args.includes('--no-infer') } };
const v = await validateImport(up.upload_id, body, user);
console.log('\nValidation summary:', JSON.stringify({ ...v.summary, issue_groups: undefined }, null, 2));
console.log('\nIssues:');
for (const g of v.summary.issue_groups) console.log(`  [${g.severity}] ${g.field}: ${g.message} × ${g.count} (rows ${g.rows.slice(0, 6).join(', ')}${g.count > 6 ? '…' : ''})`);
if (args.includes('--commit')) {
  const r = await commitImport(up.upload_id, body, user);
  console.log(`\nImported batch #${r.batch_id}: created ${r.created}, updated ${r.updated}`);
} else {
  await col.importUploads().deleteOne({ _id: up.upload_id });
}
await disconnect();
