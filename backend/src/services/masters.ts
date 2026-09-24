import { col, isDuplicateKey, masterCol, nextId, withId, type MasterTable } from '../db/mongo.ts';
import { DEFAULT_SORT, formSortOrder } from '../domain/formOrder.ts';
import { PRIORITIES } from '../domain/workflow.ts';
import { nowLocal } from '../utils/dates.ts';
import { badRequest, bool, conflict, int, notFound, oneOf, requiredStr, str } from '../utils/http.ts';

type MasterKind = 'properties' | 'categories' | 'engineers';

const OPEN_STATUSES = ['open', 'in_progress', 'pending_action', 'pending_approval', 'completed', 'on_hold'];
const CI = { locale: 'en', strength: 2 } as const;

interface MasterSpec {
  table: MasterTable;
  label: string;
  fields: Record<string, 'text' | 'bool' | 'priority' | 'int'>;
}

const SPECS: Record<MasterKind, MasterSpec> = {
  properties: { table: 'properties', label: 'Property', fields: { code: 'text', type: 'text', address: 'text', sort_order: 'int' } },
  categories: { table: 'work_categories', label: 'Work category', fields: { description: 'text', default_priority: 'priority', sort_order: 'int' } },
  engineers: { table: 'engineers', label: 'Engineer', fields: { phone: 'text', email: 'text', specialization: 'text', is_external: 'bool', slack_user_id: 'text' } },
};

export function isMasterKind(k: string): k is MasterKind {
  return k in SPECS;
}

/** id → name maps for decorating job cards. */
export async function masterNames() {
  const load = async (t: MasterTable) => new Map((await masterCol(t).find({}, { projection: { name: 1 } }).toArray()).map((m) => [m._id as number, m.name as string]));
  const [properties, categories, engineers] = await Promise.all([load('properties'), load('work_categories'), load('engineers')]);
  return { properties, categories, engineers };
}

async function usageCounts(kind: MasterKind): Promise<Map<number, { total: number; open: number }>> {
  const isOpen = { $cond: [{ $in: ['$status', OPEN_STATUSES] }, 1, 0] };
  const pipeline: object[] = kind === 'engineers'
    ? [
      { $project: { k: { $setUnion: [['$assigned_engineer_id'], ['$site_engineer_id']] }, status: 1 } },
      { $unwind: '$k' },
      { $match: { k: { $ne: null } } },
      { $group: { _id: '$k', total: { $sum: 1 }, open: { $sum: isOpen } } },
    ]
    : [{ $group: { _id: kind === 'properties' ? '$property_id' : '$category_id', total: { $sum: 1 }, open: { $sum: isOpen } } }];
  const rows = await col.requests().aggregate(pipeline).toArray();
  return new Map(rows.map((r) => [r._id as number, { total: r.total, open: r.open }]));
}

export async function listMaster(kind: MasterKind, opts: { includeInactive?: boolean } = {}) {
  const s = SPECS[kind];
  const sort: Record<string, 1> = kind === 'engineers' ? { name: 1 } : { sort_order: 1, name: 1 };
  const [rows, usage, logins] = await Promise.all([
    masterCol(s.table).find(opts.includeInactive ? {} : { active: 1 }).collation(CI).sort(sort).toArray(),
    usageCounts(kind),
    kind === 'engineers' ? col.users().find({ engineer_id: { $ne: null } }, { projection: { username: 1, engineer_id: 1 } }).toArray() : Promise.resolve([]),
  ]);
  const loginOf = new Map(logins.map((u) => [u.engineer_id, u.username]));
  return rows.map((m) => ({
    ...withId(m),
    request_count: usage.get(m._id)?.total ?? 0,
    open_count: usage.get(m._id)?.open ?? 0,
    ...(kind === 'engineers' ? { login_username: loginOf.get(m._id) ?? null } : {}),
  }));
}

function readFields(kind: MasterKind, body: any) {
  const out: Record<string, unknown> = {};
  for (const [f, t] of Object.entries(SPECS[kind].fields)) {
    if (body[f] === undefined) continue;
    out[f] = t === 'bool' ? (bool(body[f]) ? 1 : 0)
      : t === 'priority' ? oneOf(body[f], PRIORITIES, 'Default priority')
      : t === 'int' ? (int(body[f]) ?? DEFAULT_SORT)
      : str(body[f], 300);
  }
  return out;
}

export async function createMaster(kind: MasterKind, body: any) {
  const s = SPECS[kind];
  const name = requiredStr(body.name, 'Name', 120);
  if (await masterCol(s.table).findOne({ name }, { collation: CI })) throw conflict(`${s.label} "${name}" already exists`);
  const now = nowLocal();
  const doc = {
    _id: await nextId(s.table), name, active: 1,
    ...(kind === 'categories' ? { default_priority: 'medium' } : {}),
    ...(kind !== 'engineers' ? { sort_order: formSortOrder(s.table, name) } : { is_external: 0 }),
    ...readFields(kind, body), created_at: now, updated_at: now,
  };
  try {
    await masterCol(s.table).insertOne(doc);
  } catch (err) {
    if (isDuplicateKey(err)) throw conflict(`${s.label} "${name}" already exists`);
    throw err;
  }
  return withId(doc);
}

export async function updateMaster(kind: MasterKind, id: number, body: any) {
  const s = SPECS[kind];
  const existing = await masterCol(s.table).findOne({ _id: id });
  if (!existing) throw notFound(s.label);
  const fields = readFields(kind, body);
  if (body.name !== undefined) {
    const name = requiredStr(body.name, 'Name', 120);
    if (await masterCol(s.table).findOne({ name, _id: { $ne: id } }, { collation: CI })) throw conflict(`${s.label} "${name}" already exists — use Merge instead`);
    fields.name = name;
  }
  if (body.active !== undefined) fields.active = bool(body.active) ? 1 : 0;
  if (!Object.keys(fields).length) return withId(existing);
  await masterCol(s.table).updateOne({ _id: id }, { $set: { ...fields, updated_at: nowLocal() } });
  return withId(await masterCol(s.table).findOne({ _id: id }));
}

/** Merge a duplicate master record into another (e.g. "Nautre Park" → "Nature Park"). */
export async function mergeMaster(kind: MasterKind, sourceId: number, body: any) {
  const s = SPECS[kind];
  const targetId = int(body.target_id);
  if (targetId === null || targetId === sourceId) throw badRequest('Choose a different record to merge into');
  const [source, target] = await Promise.all([masterCol(s.table).findOne({ _id: sourceId }), masterCol(s.table).findOne({ _id: targetId })]);
  if (!source || !target) throw notFound(s.label);
  let moved = 0;
  if (kind === 'engineers') {
    if ((await col.users().findOne({ engineer_id: sourceId })) && (await col.users().findOne({ engineer_id: targetId }))) {
      throw conflict('Both engineers have user logins linked; unlink one first');
    }
    for (const field of ['assigned_engineer_id', 'site_engineer_id']) {
      moved += (await col.requests().updateMany({ [field]: sourceId }, { $set: { [field]: targetId } })).modifiedCount;
    }
    moved += (await col.requests().updateMany(
      { 'stages.engineer_id': sourceId },
      { $set: { 'stages.$[s].engineer_id': targetId } },
      { arrayFilters: [{ 's.engineer_id': sourceId }] },
    )).modifiedCount;
    await col.users().updateMany({ engineer_id: sourceId }, { $set: { engineer_id: targetId } });
  } else {
    const field = kind === 'properties' ? 'property_id' : 'category_id';
    moved = (await col.requests().updateMany({ [field]: sourceId }, { $set: { [field]: targetId } })).modifiedCount;
  }
  await masterCol(s.table).deleteOne({ _id: sourceId });
  return { merged: source.name, into: target.name, references_moved: moved };
}

export async function listClosureCategories() {
  return (await col.closureCategories().find().sort({ sort: 1, name: 1 }).toArray()).map(withId);
}

export async function saveClosureCategory(body: any, id?: number) {
  const name = requiredStr(body.name, 'Name', 80);
  const active = body.active === undefined ? 1 : bool(body.active) ? 1 : 0;
  const sort = int(body.sort) ?? 0;
  if (id) {
    const r = await col.closureCategories().updateOne({ _id: id }, { $set: { name, active, sort } });
    if (!r.matchedCount) throw notFound('Closure category');
    return;
  }
  if (await col.closureCategories().findOne({ name }, { collation: CI })) throw conflict('Already exists');
  await col.closureCategories().insertOne({ _id: await nextId('closure_categories'), name, active, sort });
}

/** Find-or-create by name (used by the importer and seed). */
export async function ensureMasterByName(table: MasterTable, name: string, extra: Record<string, unknown> = {}): Promise<{ id: number; created: boolean }> {
  const found = await masterCol(table).findOne({ name }, { collation: CI, projection: { _id: 1 } });
  if (found) return { id: found._id, created: false };
  const now = nowLocal();
  const doc = {
    _id: await nextId(table), name, active: 1,
    ...(table === 'engineers' ? { is_external: 0 } : { sort_order: formSortOrder(table, name) }),
    ...(table === 'work_categories' ? { default_priority: 'medium' } : {}),
    ...extra, created_at: now, updated_at: now,
  };
  try {
    await masterCol(table).insertOne(doc);
    return { id: doc._id, created: true };
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    const again = await masterCol(table).findOne({ name }, { collation: CI, projection: { _id: 1 } });
    return { id: again!._id, created: false };
  }
}
