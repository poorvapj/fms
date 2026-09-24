import { all, get, run, tx } from '../db/db.ts';
import { DEFAULT_SORT, formSortOrder } from '../domain/formOrder.ts';
import { PRIORITIES } from '../domain/workflow.ts';
import { nowLocal } from '../utils/dates.ts';
import { badRequest, bool, conflict, int, notFound, oneOf, requiredStr, str } from '../utils/http.ts';

type MasterKind = 'properties' | 'categories' | 'engineers';

interface MasterSpec {
  table: 'properties' | 'work_categories' | 'engineers';
  label: string;
  fields: Record<string, 'text' | 'bool' | 'priority' | 'int'>;
  /** Request columns that reference this master (for usage counts and merges). */
  refs: { table: string; column: string }[];
}

const SPECS: Record<MasterKind, MasterSpec> = {
  properties: {
    table: 'properties', label: 'Property',
    fields: { code: 'text', type: 'text', address: 'text', sort_order: 'int' },
    refs: [{ table: 'requests', column: 'property_id' }],
  },
  categories: {
    table: 'work_categories', label: 'Work category',
    fields: { description: 'text', default_priority: 'priority', sort_order: 'int' },
    refs: [{ table: 'requests', column: 'category_id' }],
  },
  engineers: {
    table: 'engineers', label: 'Engineer',
    fields: { phone: 'text', email: 'text', specialization: 'text', is_external: 'bool' },
    refs: [
      { table: 'requests', column: 'assigned_engineer_id' },
      { table: 'requests', column: 'site_engineer_id' },
      { table: 'request_stages', column: 'engineer_id' },
      { table: 'users', column: 'engineer_id' },
    ],
  },
};

export function isMasterKind(k: string): k is MasterKind {
  return k in SPECS;
}

export function listMaster(kind: MasterKind, opts: { includeInactive?: boolean } = {}) {
  const s = SPECS[kind];
  const usage = kind === 'engineers'
    ? `(SELECT COUNT(*) FROM requests r WHERE r.assigned_engineer_id = m.id OR r.site_engineer_id = m.id) AS request_count,
       (SELECT COUNT(*) FROM requests r WHERE (r.assigned_engineer_id = m.id OR r.site_engineer_id = m.id) AND r.status IN ('open','in_progress','pending_action','pending_approval','completed')) AS open_count,
       (SELECT u.username FROM users u WHERE u.engineer_id = m.id LIMIT 1) AS login_username`
    : `(SELECT COUNT(*) FROM requests r WHERE r.${s.refs[0].column} = m.id) AS request_count,
       (SELECT COUNT(*) FROM requests r WHERE r.${s.refs[0].column} = m.id AND r.status IN ('open','in_progress','pending_action','pending_approval','completed')) AS open_count`;
  return all(`SELECT m.*, ${usage} FROM ${s.table} m ${opts.includeInactive ? '' : 'WHERE m.active = 1'} ORDER BY ${kind === 'engineers' ? '' : 'm.sort_order, '}m.name COLLATE NOCASE`);
}

function readFields(kind: MasterKind, body: any) {
  const out: Record<string, unknown> = {};
  for (const [f, t] of Object.entries(SPECS[kind].fields)) {
    if (body[f] === undefined) continue;
    out[f] = t === 'bool' ? (bool(body[f]) ? 1 : 0) : t === 'priority' ? oneOf(body[f], PRIORITIES, 'Default priority') : t === 'int' ? (int(body[f]) ?? DEFAULT_SORT) : str(body[f], 300);
  }
  return out;
}

export function createMaster(kind: MasterKind, body: any) {
  const s = SPECS[kind];
  const name = requiredStr(body.name, 'Name', 120);
  if (get(`SELECT 1 FROM ${s.table} WHERE name = ?`, [name])) throw conflict(`${s.label} "${name}" already exists`);
  const fields = readFields(kind, body);
  const cols = ['name', ...Object.keys(fields), 'created_at', 'updated_at'];
  const now = nowLocal();
  const { lastInsertRowid } = run(
    `INSERT INTO ${s.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    [name, ...(Object.values(fields) as any[]), now, now],
  );
  return get(`SELECT * FROM ${s.table} WHERE id = ?`, [lastInsertRowid]);
}

export function updateMaster(kind: MasterKind, id: number, body: any) {
  const s = SPECS[kind];
  const existing = get(`SELECT * FROM ${s.table} WHERE id = ?`, [id]);
  if (!existing) throw notFound(s.label);
  const fields = readFields(kind, body);
  if (body.name !== undefined) {
    const name = requiredStr(body.name, 'Name', 120);
    const dupe = get(`SELECT id FROM ${s.table} WHERE name = ? AND id <> ?`, [name, id]);
    if (dupe) throw conflict(`${s.label} "${name}" already exists — use Merge instead`);
    fields.name = name;
  }
  if (body.active !== undefined) fields.active = bool(body.active) ? 1 : 0;
  if (!Object.keys(fields).length) return existing;
  run(
    `UPDATE ${s.table} SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    [...(Object.values(fields) as any[]), nowLocal(), id],
  );
  return get(`SELECT * FROM ${s.table} WHERE id = ?`, [id]);
}

/** Merge a duplicate master record into another (e.g. "Nautre Park" → "Nature Park"). */
export function mergeMaster(kind: MasterKind, sourceId: number, body: any) {
  const s = SPECS[kind];
  const targetId = int(body.target_id);
  if (targetId === null || targetId === sourceId) throw badRequest('Choose a different record to merge into');
  const source = get(`SELECT * FROM ${s.table} WHERE id = ?`, [sourceId]);
  const target = get(`SELECT * FROM ${s.table} WHERE id = ?`, [targetId]);
  if (!source || !target) throw notFound(s.label);
  if (kind === 'engineers' && get('SELECT 1 FROM users WHERE engineer_id = ?', [sourceId]) && get('SELECT 1 FROM users WHERE engineer_id = ?', [targetId])) {
    throw conflict('Both engineers have user logins linked; unlink one first');
  }
  return tx(() => {
    let moved = 0;
    for (const ref of s.refs) moved += run(`UPDATE ${ref.table} SET ${ref.column} = ? WHERE ${ref.column} = ?`, [targetId, sourceId]).changes;
    run(`DELETE FROM ${s.table} WHERE id = ?`, [sourceId]);
    return { merged: source.name, into: target.name, references_moved: moved };
  });
}

export function listClosureCategories() {
  return all('SELECT * FROM closure_categories ORDER BY sort, name');
}

export function saveClosureCategory(body: any, id?: number) {
  const name = requiredStr(body.name, 'Name', 80);
  const active = body.active === undefined ? 1 : bool(body.active) ? 1 : 0;
  const sort = int(body.sort) ?? 0;
  if (id) {
    if (!get('SELECT 1 FROM closure_categories WHERE id = ?', [id])) throw notFound('Closure category');
    run('UPDATE closure_categories SET name = ?, active = ?, sort = ? WHERE id = ?', [name, active, sort, id]);
    return;
  }
  if (get('SELECT 1 FROM closure_categories WHERE name = ?', [name])) throw conflict('Already exists');
  run('INSERT INTO closure_categories (name, active, sort) VALUES (?, ?, ?)', [name, active, sort]);
}

/** Find-or-create by name (used by the importer). */
export function ensureMasterByName(table: 'properties' | 'work_categories' | 'engineers', name: string, extra: Record<string, unknown> = {}): { id: number; created: boolean } {
  const row = get<{ id: number }>(`SELECT id FROM ${table} WHERE name = ?`, [name]);
  if (row) return { id: row.id, created: false };
  const now = nowLocal();
  const withOrder = table === 'engineers' ? extra : { sort_order: formSortOrder(table, name), ...extra };
  const cols = ['name', ...Object.keys(withOrder), 'created_at', 'updated_at'];
  const { lastInsertRowid } = run(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    [name, ...(Object.values(withOrder) as any[]), now, now],
  );
  return { id: lastInsertRowid, created: true };
}
