// Usage: npm run import:cli -- "<file.tsv>" [--commit] [--update] [--no-infer]
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AuthUser } from '../auth/auth.ts';
import { get } from '../db/db.ts';
import { ensureBaseData } from '../db/seed.ts';
import { commitImport, preview, saveUpload, validateImport } from './importService.ts';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: import:cli -- <file.tsv> [--commit] [--update] [--no-infer]');
  process.exit(1);
}
ensureBaseData();
const admin = get(`SELECT id, username, name, role, engineer_id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1`)!;
const user: AuthUser = { ...admin, must_change_password: false } as AuthUser;

const up = saveUpload({ buffer: readFileSync(file), originalname: path.basename(file), size: statSync(file).size }, user);
const p = preview(up.upload_id, user);
console.log(`Layout: ${p.layout.format}, header row ${p.layout.header_row + 1}, ${p.layout.data_rows} data rows, export at ${p.layout.export_at}`);
for (const c of p.layout.columns) console.log(`  ${c.letter.padEnd(3)} ${(c.group || '').padEnd(34).slice(0, 34)} ${(c.header || '(blank)').padEnd(30).slice(0, 30)} → ${p.mapping[String(c.index)] || '(ignored)'}`);

const body = { mapping: p.mapping, options: { mode: args.includes('--update') ? 'update' : 'skip', infer_planned: !args.includes('--no-infer') } };
const v = validateImport(up.upload_id, body, user);
console.log('\nValidation summary:', JSON.stringify({ ...v.summary, issue_groups: undefined }, null, 2));
console.log('\nIssues:');
for (const g of v.summary.issue_groups) console.log(`  [${g.severity}] ${g.field}: ${g.message} × ${g.count} (rows ${g.rows.slice(0, 6).join(', ')}${g.count > 6 ? '…' : ''})`);
if (args.includes('--commit')) {
  const r = commitImport(up.upload_id, body, user);
  console.log(`\nImported batch #${r.batch_id}: created ${r.created}, updated ${r.updated}`);
}
