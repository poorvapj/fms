import { fileURLToPath } from 'node:url';
import { hashPassword } from '../auth/auth.ts';
import { DEFAULT_SORT, formSortOrder } from '../domain/formOrder.ts';
import { ensureMasterByName } from '../services/masters.ts';
import { loadStageDefs } from '../services/stageDefs.ts';
import { nowLocal } from '../utils/dates.ts';
import { col, connect, disconnect, masterCol, nextId } from './mongo.ts';

const CLOSURE_CATEGORIES = ['Work Done', 'Service / Repair Complaint', 'Wrong Complaint', 'Duplicate', 'Rejected', 'Not Feasible', 'Other'];

/** Idempotent base data required for the app to run. */
export async function ensureBaseData() {
  await loadStageDefs();
  for (const [i, name] of CLOSURE_CATEGORIES.entries()) {
    if (!(await col.closureCategories().findOne({ name }))) {
      await col.closureCategories().insertOne({ _id: await nextId('closure_categories'), name, sort: i, active: 1 });
    }
  }
  // Give masters the Google Form dropdown order (only those never ordered by an admin).
  for (const table of ['properties', 'work_categories'] as const) {
    for (const r of await masterCol(table).find({ sort_order: DEFAULT_SORT }, { projection: { name: 1 } }).toArray()) {
      const order = formSortOrder(table, r.name);
      if (order !== DEFAULT_SORT) await masterCol(table).updateOne({ _id: r._id }, { $set: { sort_order: order } });
    }
  }
  if (!(await col.users().countDocuments())) {
    const password = process.env.ADMIN_PASSWORD ?? 'Admin@12345';
    const now = nowLocal();
    await col.users().insertOne({
      _id: await nextId('users'), username: 'admin', name: 'Administrator', email: null, phone: null, password_hash: hashPassword(password),
      role: 'admin', engineer_id: null, active: 1, must_change_password: 1, last_login_at: null, created_at: now, updated_at: now,
    });
    console.log(`Created initial administrator: username "admin"${process.env.ADMIN_PASSWORD ? ' (password from ADMIN_PASSWORD)' : `, password "${password}"`} — change on first login`);
  }
}

/** Demo logins for each role (npm run seed). */
async function seedDemo() {
  await connect();
  await ensureBaseData();
  const now = nowLocal();
  const pw = hashPassword('Welcome@123');
  const kuldeep = (await ensureMasterByName('engineers', 'Kuldeep')).id;
  const demo: [string, string, string, number | null][] = [
    ['coordinator', 'Process Coordinator', 'coordinator', null],
    ['projecthead', 'Project Head', 'project_head', null],
    ['approver', 'Management Approver', 'approver', null],
    ['store', 'Store / Material', 'store', null],
    ['kuldeep', 'Kuldeep', 'engineer', kuldeep],
    ['viewer', 'Report Viewer', 'viewer', null],
    ['requester', 'Property Staff', 'requester', null],
  ];
  for (const [username, name, role, eng] of demo) {
    if (await col.users().findOne({ username })) continue;
    await col.users().insertOne({
      _id: await nextId('users'), username, name, email: null, phone: null, password_hash: pw, role, engineer_id: eng,
      active: 1, must_change_password: 0, last_login_at: null, created_at: now, updated_at: now,
    });
  }
  for (const p of ['Garden City', 'School', 'Regal Garden']) await ensureMasterByName('properties', p);
  for (const c of ['Electric', 'Plumbing', 'Civil', 'Others']) await ensureMasterByName('work_categories', c);
  console.log('Demo users ready (password "Welcome@123"): ' + demo.map((d) => d[0]).join(', '));
  await disconnect();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await seedDemo();
