import { fileURLToPath } from 'node:url';
import { hashPassword } from '../auth/auth.ts';
import { ensureMasterByName } from '../services/masters.ts';
import { nowLocal } from '../utils/dates.ts';
import { DEFAULT_SORT, formSortOrder } from '../domain/formOrder.ts';
import { all, get, run } from './db.ts';

const CLOSURE_CATEGORIES = ['Work Done', 'Service / Repair Complaint', 'Wrong Complaint', 'Duplicate', 'Rejected', 'Not Feasible', 'Other'];

/** Idempotent base data required for the app to run. */
export function ensureBaseData() {
  CLOSURE_CATEGORIES.forEach((name, i) => run('INSERT OR IGNORE INTO closure_categories (name, sort) VALUES (?, ?)', [name, i]));
  // Give existing masters the Google Form dropdown order (only those never ordered by an admin).
  for (const table of ['properties', 'work_categories'] as const) {
    for (const r of all<{ id: number; name: string }>(`SELECT id, name FROM ${table} WHERE sort_order = ${DEFAULT_SORT}`)) {
      const order = formSortOrder(table, r.name);
      if (order !== DEFAULT_SORT) run(`UPDATE ${table} SET sort_order = ? WHERE id = ?`, [order, r.id]);
    }
  }
  const users = get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
  if (!users) {
    const password = process.env.ADMIN_PASSWORD ?? 'Admin@12345';
    const now = nowLocal();
    run(
      `INSERT INTO users (username, name, password_hash, role, must_change_password, created_at, updated_at) VALUES ('admin', 'Administrator', ?, 'admin', 1, ?, ?)`,
      [hashPassword(password), now, now],
    );
    console.log(`Created initial administrator: username "admin", password "${password}" (change on first login)`);
  }
}

/** Demo logins for each role (npm run seed). */
function seedDemo() {
  ensureBaseData();
  const now = nowLocal();
  const pw = hashPassword('Welcome@123');
  const kuldeep = ensureMasterByName('engineers', 'Kuldeep').id;
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
    run(
      `INSERT OR IGNORE INTO users (username, name, password_hash, role, engineer_id, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      [username, name, pw, role, eng, now, now],
    );
  }
  for (const p of ['Garden City', 'School', 'Regal Garden']) ensureMasterByName('properties', p);
  for (const c of ['Electric', 'Plumbing', 'Civil', 'Others']) ensureMasterByName('work_categories', c);
  console.log('Demo users created (password "Welcome@123"): ' + demo.map((d) => d[0]).join(', '));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) seedDemo();
