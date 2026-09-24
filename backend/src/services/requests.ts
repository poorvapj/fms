import { randomBytes } from 'node:crypto';
import type { Filter } from 'mongodb';
import type { AuthUser } from '../auth/auth.ts';
import { col, nextId, nextSequence, withId, type Doc } from '../db/mongo.ts';
import { can } from '../domain/permissions.ts';
import { normalizeWorkType, PRIORITIES, REQUEST_STATUSES, STAGE_KEYS } from '../domain/workflow.ts';
import { diffMinutes, normalizeLocal, nowLocal } from '../utils/dates.ts';
import { badRequest, forbidden, int, notFound, oneOf, requiredStr, str } from '../utils/http.ts';
import { storeFile, removeFiles } from './attachments.ts';
import { eventDoc, logEvent } from './events.ts';
import { masterNames } from './masters.ts';
import { stageDefs, stageName } from './stageDefs.ts';
import { newStages, refreshState, saveRequest, type RequestDoc } from './workflowEngine.ts';

/** Statuses that still need work (on-hold jobs are open too, but not "live"). */
export const LIVE_STATUSES = ['open', 'in_progress', 'pending_action', 'pending_approval', 'completed'];

/** Live and past its current stage's planned time. */
export function overdueFilter(now: string): Filter<Doc> {
  return { status: { $in: LIVE_STATUSES }, current_stage_planned_at: { $ne: null, $lt: now } };
}

export function isOverdue(r: Doc, now: string) {
  return LIVE_STATUSES.includes(r.status) && !!r.current_stage_planned_at && r.current_stage_planned_at < now;
}

/** Row-level visibility for the signed-in user. */
export function scopeFilter(user: AuthUser): Filter<Doc> {
  if (can(user.role, 'request.view_all')) return {};
  if (can(user.role, 'request.view_assigned')) {
    const e = user.engineer_id ?? -1;
    return { $or: [{ assigned_engineer_id: e }, { site_engineer_id: e }, { created_by: user.id }, { 'stages.engineer_id': e }] };
  }
  return { created_by: user.id };
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function buildFilter(f: Record<string, any>, user: AuthUser): { filter: Filter<Doc>; now: string } {
  const now = nowLocal();
  const and: Filter<Doc>[] = [scopeFilter(user)];
  const list = (v: unknown) => String(v).split(',').map((s) => s.trim()).filter(Boolean);
  const intList = (v: unknown) => list(v).map(Number).filter(Number.isInteger);
  if (f.property_id) and.push({ property_id: { $in: intList(f.property_id) } });
  if (f.category_id) and.push({ category_id: { $in: intList(f.category_id) } });
  if (f.status) {
    const statuses = list(f.status).filter((s) => REQUEST_STATUSES.some((x) => x.key === s) || s === 'active');
    const expanded = statuses.flatMap((s) => (s === 'active' ? LIVE_STATUSES : [s]));
    if (expanded.length) and.push({ status: { $in: expanded } });
  }
  if (f.stage) and.push({ current_stage_key: { $in: list(f.stage).filter((s) => STAGE_KEYS.includes(s as any)) } });
  if (f.priority) and.push({ priority: { $in: list(f.priority).filter((s) => PRIORITIES.includes(s as any)) } });
  const eng = int(f.engineer_id);
  if (eng !== null) and.push({ $or: [{ assigned_engineer_id: eng }, { site_engineer_id: eng }] });
  if (['ui', 'fms_import', 'public'].includes(f.source)) and.push({ source: f.source });
  const range = (field: string, fromV: unknown, toV: unknown) => {
    const from = normalizeLocal(fromV);
    const to = normalizeLocal(toV);
    const cond: Record<string, string> = {};
    if (from) cond.$gte = from.slice(0, 10);
    if (to) cond.$lte = `${to.slice(0, 10)}T23:59:59`;
    if (Object.keys(cond).length) and.push({ [field]: cond });
  };
  range('requested_at', f.from, f.to);
  range('completed_at', f.closed_from, f.closed_to);
  if (f.overdue === '1' || f.overdue === 'true' || f.overdue === true) and.push(overdueFilter(now));
  const q = str(f.q, 100);
  if (q) {
    const re = { $regex: escapeRegex(q), $options: 'i' };
    and.push({ $or: ['request_no', 'title', 'description', 'requester_name', 'property_no', 'requester_email'].map((k) => ({ [k]: re })) });
  }
  return { filter: and.length === 1 ? and[0] : { $and: and }, now };
}

/** Fields needed for list rows (no stages / description). */
export const LIST_PROJECTION = {
  request_no: 1, source: 1, title: 1, priority: 1, status: 1, requested_at: 1, target_date: 1, location_detail: 1, property_no: 1,
  work_type: 1, current_stage_key: 1, current_stage_planned_at: 1, completed_at: 1, closed_at: 1, hold_reason: 1, property_id: 1,
  category_id: 1, assigned_engineer_id: 1, site_engineer_id: 1, held_at: 1,
};

type Names = Awaited<ReturnType<typeof masterNames>>;

export function listRow(r: Doc, names: Names, now: string) {
  const overdue = isOverdue(r, now);
  return {
    id: r._id, request_no: r.request_no, source: r.source, title: r.title, priority: r.priority, status: r.status,
    requested_at: r.requested_at, target_date: r.target_date ?? null, location_detail: r.location_detail ?? null,
    property_no: r.property_no ?? null, work_type: r.work_type ?? null, current_stage_key: r.current_stage_key ?? null,
    current_stage_name: stageName(r.current_stage_key), current_stage_planned_at: r.current_stage_planned_at ?? null,
    completed_at: r.completed_at ?? null, closed_at: r.closed_at ?? null, hold_reason: r.hold_reason ?? null,
    property_id: r.property_id, property_name: names.properties.get(r.property_id) ?? '—',
    category_id: r.category_id, category_name: names.categories.get(r.category_id) ?? '—',
    assigned_engineer_id: r.assigned_engineer_id ?? null, engineer_name: names.engineers.get(r.assigned_engineer_id) ?? null,
    site_engineer_id: r.site_engineer_id ?? null, site_engineer_name: names.engineers.get(r.site_engineer_id) ?? null,
    is_overdue: overdue, overdue_minutes: overdue ? diffMinutes(now, r.current_stage_planned_at) : null,
  };
}

export async function findRows(filter: Filter<Doc>, sort: Record<string, 1 | -1>, limit = 500) {
  const [rows, names] = await Promise.all([col.requests().find(filter, { projection: LIST_PROJECTION }).sort(sort).limit(limit).toArray(), masterNames()]);
  const now = nowLocal();
  return rows.map((r) => listRow(r, names, now));
}

const PRIORITY_RANK = { $switch: { branches: [{ case: { $eq: ['$priority', 'critical'] }, then: 4 }, { case: { $eq: ['$priority', 'high'] }, then: 3 }, { case: { $eq: ['$priority', 'medium'] }, then: 2 }], default: 1 } };
const NAME_SORTS: Record<string, { from: string; field: string }> = {
  property: { from: 'properties', field: 'property_id' },
  category: { from: 'work_categories', field: 'category_id' },
  engineer: { from: 'engineers', field: 'assigned_engineer_id' },
};

export async function listRequests(query: Record<string, any>, user: AuthUser) {
  const { filter, now } = buildFilter(query, user);
  const page = Math.max(1, int(query.page) ?? 1);
  const pageSize = Math.min(500, Math.max(1, int(query.page_size) ?? 25));
  const dir = query.dir === 'asc' ? 1 : -1;
  const pipeline: object[] = [{ $match: filter }];
  const key = String(query.sort ?? 'requested_at');
  if (NAME_SORTS[key]) {
    const n = NAME_SORTS[key];
    pipeline.push({ $lookup: { from: n.from, localField: n.field, foreignField: '_id', as: '_m' } }, { $addFields: { _sort: { $toLower: { $first: '$_m.name' } } } });
  } else if (key === 'priority') {
    pipeline.push({ $addFields: { _sort: PRIORITY_RANK } });
  }
  const field = NAME_SORTS[key] || key === 'priority' ? '_sort'
    : ({ requested_at: 'requested_at', request_no: 'request_no', status: 'status', planned: 'current_stage_planned_at' } as Record<string, string>)[key] ?? 'requested_at';
  pipeline.push({ $sort: { [field]: dir, _id: -1 } }, { $skip: (page - 1) * pageSize }, { $limit: pageSize }, { $project: LIST_PROJECTION });
  const [total, rows, names] = await Promise.all([col.requests().countDocuments(filter), col.requests().aggregate(pipeline).toArray(), masterNames()]);
  return { total, page, page_size: pageSize, rows: rows.map((r) => listRow(r, names, now)) };
}

export async function exportRequests(query: Record<string, any>, user: AuthUser) {
  const { filter } = buildFilter(query, user);
  return findRows(filter, { requested_at: -1 }, 50000);
}

export async function loadRequest(id: number): Promise<RequestDoc> {
  const r = await col.requests().findOne({ _id: id });
  if (!r) throw notFound('Job card');
  return r as RequestDoc;
}

export function canView(user: AuthUser, r: Doc): boolean {
  if (can(user.role, 'request.view_all')) return true;
  if (can(user.role, 'request.view_assigned') && user.engineer_id) {
    if (r.assigned_engineer_id === user.engineer_id || r.site_engineer_id === user.engineer_id) return true;
    if ((r.stages ?? []).some((s: Doc) => s.engineer_id === user.engineer_id)) return true;
  }
  return r.created_by === user.id;
}

export function assertCanView(user: AuthUser, r: Doc) {
  if (!canView(user, r)) throw forbidden('You do not have access to this job card');
}

export async function getRequestDetail(id: number, user: AuthUser) {
  const r = await loadRequest(id);
  assertCanView(user, r);
  const now = nowLocal();
  const [names, creator, attachments, events, legacyRow] = await Promise.all([
    masterNames(),
    r.created_by ? col.users().findOne({ _id: r.created_by }, { projection: { name: 1 } }) : null,
    col.attachments().find({ request_id: id }).sort({ created_at: 1, _id: 1 }).toArray(),
    col.events().find({ request_id: id }).sort({ created_at: -1, _id: -1 }).toArray(),
    r.source === 'fms_import' ? col.legacyRows().findOne({ request_id: id }) : null,
  ]);
  const userIds = [...new Set([...attachments.map((a) => a.uploaded_by), ...r.stages.map((s) => s.updated_by)].filter((x) => x !== null && x !== undefined))];
  const userNames = new Map((await col.users().find({ _id: { $in: userIds } }, { projection: { name: 1 } }).toArray()).map((u) => [u._id, u.name]));
  const defs = new Map(stageDefs().map((d) => [d.key, d]));
  const stages = r.stages.map((s, i) => {
    const d = defs.get(s.stage_key);
    const running = s.status === 'active' && s.planned_at && s.planned_at < now && r.status !== 'on_hold' ? diffMinutes(now, s.planned_at) : null;
    return {
      id: i + 1, ...s,
      name: d?.name ?? s.stage_key, group: d?.group, optional: d?.optional ?? false, decision_stage: d?.decision ?? false,
      requires_evidence: d?.requiresEvidence ?? false, engineer_name: names.engineers.get(s.engineer_id ?? -1) ?? null,
      updated_by_name: userNames.get(s.updated_by) ?? null, running_delay_minutes: running,
    };
  });
  let legacy = null;
  if (legacyRow) {
    const batch = await col.batches().findOne({ _id: legacyRow.batch_id }, { projection: { columns: 1, file_name: 1 } });
    const columns: { group: string; header: string }[] = batch?.columns ?? [];
    legacy = {
      batch_id: legacyRow.batch_id, file_name: batch?.file_name ?? '', row_no: legacyRow.row_no,
      cells: (legacyRow.cells as string[]).map((value, i) => ({ index: i + 1, group: columns[i]?.group ?? '', header: columns[i]?.header ?? '', value })),
    };
  }
  const { stages: _s, legacy_key: _k, public_token: _t, requester_ip: _ip, ...fields } = r;
  const overdue = isOverdue(r, now);
  return {
    request: {
      ...withId(fields as Doc),
      property_name: names.properties.get(r.property_id) ?? '—', category_name: names.categories.get(r.category_id) ?? '—',
      engineer_name: names.engineers.get(r.assigned_engineer_id) ?? null, site_engineer_name: names.engineers.get(r.site_engineer_id) ?? null,
      created_by_name: creator?.name ?? null, current_stage_name: stageName(r.current_stage_key),
      is_overdue: overdue, overdue_minutes: overdue ? diffMinutes(now, r.current_stage_planned_at) : null,
    },
    stages,
    attachments: attachments.map((a) => ({
      id: a._id, stage_key: a.stage_key, kind: a.kind, url: a.url ?? null, file_name: a.file_name ?? null, mime: a.mime ?? null, size: a.size ?? null,
      caption: a.caption ?? null, source: a.source, created_at: a.created_at, uploaded_by_name: userNames.get(a.uploaded_by) ?? null,
    })),
    events: events.map((e) => ({ id: e._id, stage_key: e.stage_key, type: e.type, message: e.message, data: e.data, user_name: e.user_name, created_at: e.created_at })),
    legacy,
  };
}

async function resolveRef(table: 'properties' | 'work_categories', id: unknown, label: string): Promise<number> {
  const n = int(id);
  if (n === null) throw badRequest(`${label} is required`);
  const c = table === 'properties' ? col.properties() : col.categories();
  if (!(await c.findOne({ _id: n, active: 1 }, { projection: { _id: 1 } }))) throw badRequest(`${label} not found or inactive`);
  return n;
}

export interface UploadedImage { originalname: string; mimetype: string; size: number; buffer: Buffer }

export const IMAGE_MIME = /^image\/(jpeg|png|gif|webp|heic|heif)$/;

/** Allocate the next job card number for a year: JC-YYYY-NNNNNN. */
export async function nextJobNumbers(year: string, count = 1): Promise<string[]> {
  const first = await nextSequence(`jobcard-${year}`, count);
  return Array.from({ length: count }, (_, i) => `JC-${year}-${String(first + i).padStart(6, '0')}`);
}

/**
 * Shared creation path for signed-in users and the public form.
 * At least one location image (uploaded file or link) is compulsory.
 */
export async function createRequest(body: any, user: AuthUser | null, images: UploadedImage[] = [], opts: { source?: 'ui' | 'public'; ip?: string | null } = {}) {
  const source = opts.source ?? 'ui';
  const propertyId = await resolveRef('properties', body.property_id, 'Property');
  const categoryId = await resolveRef('work_categories', body.category_id, 'Work category');
  const description = requiredStr(body.description, 'Description', 5000);
  if (description.length < 10) throw badRequest('Please describe the problem in a little more detail');
  const title = str(body.title, 150) ?? description.replace(/\s+/g, ' ').slice(0, 80);
  const cat = await col.categories().findOne({ _id: categoryId }, { projection: { default_priority: 1 } });
  const priority = body.priority && user ? oneOf(body.priority, PRIORITIES, 'Priority') : (cat?.default_priority ?? 'medium');
  const requestedAt = nowLocal();
  const target = normalizeLocal(body.target_date)?.slice(0, 10) ?? null;
  if (target && target < requestedAt.slice(0, 10)) throw badRequest('Target date cannot be in the past');
  const email = str(body.requester_email, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('Enter a valid email address');
  const requesterName = str(body.requester_name, 120) ?? user?.name ?? email?.split('@')[0] ?? null;
  const contact = str(body.requester_contact, 120);
  // Fields of the "Job Card-Work Capture Form"
  const workType = normalizeWorkType(body.work_type);
  if (!workType) throw badRequest('Select the type of work (New Work / Maintenance)');
  const propertyNo = requiredStr(body.property_no, 'Property No.', 120);
  const reason = source === 'public' ? requiredStr(body.reason, 'Reason', 2000) : str(body.reason, 2000);
  if (source === 'public') {
    if (!email) throw badRequest('Email is required');
    if (!target) throw badRequest('Work completion date is required');
  }
  const rawUrls = Array.isArray(body.image_urls) ? body.image_urls : body.image_urls ? [body.image_urls] : [];
  const urls = rawUrls.map((u: unknown) => str(u, 2000)).filter((u: string | null): u is string => !!u && /^https?:\/\//i.test(u));
  if (source === 'public' && urls.length) throw badRequest('Please upload the image file');
  if (images.some((f) => !IMAGE_MIME.test(f.mimetype))) throw badRequest('Only image files (JPG, PNG, WEBP, HEIC) are allowed');
  if (!images.length && !urls.length) throw badRequest('At least one image of the location is required');
  if (images.length + urls.length > 10) throw badRequest('Upload at most 10 images');

  const fileIds = await Promise.all(images.map((f) => storeFile(f)));
  try {
    const id = await nextId('requests');
    const [requestNo] = await nextJobNumbers(requestedAt.slice(0, 4));
    const token = source === 'public' ? randomBytes(18).toString('base64url') : null;
    const doc: RequestDoc = {
      _id: id, request_no: requestNo, source, title, description, property_id: propertyId, category_id: categoryId, priority,
      location_detail: str(body.location_detail, 300), work_type: workType, property_no: propertyNo, reason, requester_email: email,
      requested_at: requestedAt, requester_name: requesterName, requester_contact: contact, created_by: user?.id ?? null, target_date: target,
      status: 'open', current_stage_key: null, current_stage_planned_at: null, site_engineer_id: null, assigned_engineer_id: null,
      requires_ph_discussion: null, requires_material: null, requires_permission: null, hold_reason: null, held_at: null,
      cancelled_at: null, cancel_reason: null, completed_at: null, closed_at: null, closure_category: null, closure_note: null,
      verified_by_name: null, public_token: token, requester_ip: opts.ip ?? null, import_batch_id: null, import_row_no: null,
      modified_in_app: false, version: 1, created_at: requestedAt, updated_at: requestedAt,
      stages: newStages(requestedAt, user?.id ?? null, requesterName),
    };
    refreshState(doc);
    await col.requests().insertOne(doc);
    const attIds = images.length + urls.length ? await nextId('attachments', images.length + urls.length) : 0;
    const attachments = [
      ...images.map((f, i) => ({
        _id: attIds + i, request_id: id, stage_key: 'created', kind: 'file', file_id: fileIds[i], file_name: f.originalname.slice(0, 200), mime: f.mimetype,
        size: f.size, caption: images.length > 1 ? `Image of location ${i + 1}` : 'Image of location', source, uploaded_by: user?.id ?? null, created_at: requestedAt,
      })),
      ...urls.map((u: string, i: number) => ({
        _id: attIds + images.length + i, request_id: id, stage_key: 'created', kind: 'url', url: u, caption: 'Image of location', source: 'ui', uploaded_by: user?.id ?? null, created_at: requestedAt,
      })),
    ];
    if (attachments.length) await col.attachments().insertMany(attachments);
    await col.events().insertOne(eventDoc(await nextId('request_events'), id, 'created', `Job card ${requestNo} raised${source === 'public' ? ' via public form' : ''}`, { stageKey: 'created', user, userName: requesterName ?? undefined }));
    return { id, request_no: requestNo, tracking_token: token };
  } catch (err) {
    await removeFiles(fileIds);
    throw err;
  }
}

const EDITABLE: Record<string, 'text' | 'priority' | 'date' | 'property' | 'category'> = {
  title: 'text', description: 'text', location_detail: 'text', property_no: 'text', reason: 'text', requester_email: 'text',
  requester_name: 'text', requester_contact: 'text', priority: 'priority', target_date: 'date', property_id: 'property', category_id: 'category',
};

export async function updateRequest(id: number, body: any, user: AuthUser) {
  if (!can(user.role, 'request.edit')) throw forbidden();
  const r = await loadRequest(id);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [field, kind] of Object.entries(EDITABLE)) {
    if (body[field] === undefined) continue;
    let value: unknown;
    if (kind === 'text') value = field === 'title' ? requiredStr(body[field], 'Title', 150) : str(body[field], 5000);
    else if (kind === 'priority') value = oneOf(body[field], PRIORITIES, 'Priority');
    else if (kind === 'date') value = normalizeLocal(body[field])?.slice(0, 10) ?? null;
    else if (kind === 'property') value = await resolveRef('properties', body[field], 'Property');
    else value = await resolveRef('work_categories', body[field], 'Work category');
    if (value === r[field]) continue;
    changes[field] = { from: r[field], to: value };
    r[field] = value;
  }
  if (!Object.keys(changes).length) return;
  await saveRequest(r);
  await logEvent(id, 'edited', `Updated ${Object.keys(changes).join(', ').replace(/_id\b/g, '')}`, { user, data: changes });
}
