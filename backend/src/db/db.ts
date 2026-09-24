import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { config } from '../config.ts';
import { DEFAULT_STAGES } from '../domain/workflow.ts';

export type Params = Record<string, SQLInputValue | boolean | undefined> | SQLInputValue[];
export type Row = Record<string, any>;

export const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

// Additive migrations for databases created by earlier versions.
const requestCols = new Set((db.prepare('PRAGMA table_info(requests)').all() as { name: string }[]).map((c) => c.name));
for (const col of ['work_type', 'property_no', 'reason', 'requester_email']) {
  if (!requestCols.has(col)) db.exec(`ALTER TABLE requests ADD COLUMN ${col} TEXT`);
}
for (const table of ['properties', 'work_categories']) {
  const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  if (!cols.has('sort_order')) db.exec(`ALTER TABLE ${table} ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 999`);
}

function bind(sql: string, params?: Params): SQLInputValue[] | [Record<string, SQLInputValue>] {
  if (params === undefined) return [];
  const fix = (v: unknown): SQLInputValue => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as SQLInputValue));
  if (Array.isArray(params)) return params.map(fix);
  const out: Record<string, SQLInputValue> = {};
  // node:sqlite rejects unknown named parameters, so pass only those the statement references.
  for (const [k, v] of Object.entries(params)) if (new RegExp(`[:@$]${k}\\b`).test(sql)) out[k] = fix(v);
  return [out];
}

const cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
function stmt(sql: string) {
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

export function all<T = Row>(sql: string, params?: Params): T[] {
  return stmt(sql).all(...(bind(sql, params) as SQLInputValue[])) as T[];
}

export function get<T = Row>(sql: string, params?: Params): T | undefined {
  return stmt(sql).get(...(bind(sql, params) as SQLInputValue[])) as T | undefined;
}

export function run(sql: string, params?: Params): { changes: number; lastInsertRowid: number } {
  const r = stmt(sql).run(...(bind(sql, params) as SQLInputValue[]));
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

let depth = 0;
/** Run fn in a transaction (nested calls reuse the outer one). */
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

export function nextSequence(name: string): number {
  run('INSERT INTO sequences(name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1', [name]);
  return get<{ value: number }>('SELECT value FROM sequences WHERE name = ?', [name])!.value;
}

/** Ensure workflow stage definitions exist (keeps admin-edited SLA rules). */
export function ensureWorkflowStages() {
  for (const s of DEFAULT_STAGES) {
    run(
      `INSERT INTO workflow_stages (key, seq, name, stage_group, optional, action_roles, responsible_label, sla_rule, requires_evidence, decision, legacy_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET seq = excluded.seq, stage_group = excluded.stage_group, optional = excluded.optional,
         decision = excluded.decision, legacy_name = excluded.legacy_name`,
      [s.key, s.seq, s.name, s.group, s.optional ? 1 : 0, JSON.stringify(s.roles), s.responsibleLabel, JSON.stringify(s.sla), s.requiresEvidence ? 1 : 0, s.decision ? 1 : 0, s.legacyName ?? null],
    );
  }
}
ensureWorkflowStages();
