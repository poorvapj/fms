import { randomBytes } from 'node:crypto';
import type { AuthUser } from '../auth/auth.ts';
import { all, get, nextSequence, run, tx, type Row } from '../db/db.ts';
import { can } from '../domain/permissions.ts';
import { normalizeWorkType, PRIORITIES, REQUEST_STATUSES, STAGE_KEYS } from '../domain/workflow.ts';
import { diffMinutes, normalizeLocal, nowLocal } from '../utils/dates.ts';
import { badRequest, forbidden, int, notFound, oneOf, requiredStr, str } from '../utils/http.ts';
import { logEvent } from './events.ts';
import { stageDefs, stageName } from './stageDefs.ts';
import { createStageRows, refreshRequestState } from './workflowEngine.ts';

export const OPEN_STATUSES = ['open', 'in_progress', 'pending_action', 'pending_approval', 'completed'];

/** SQL fragment: request is live (not closed, cancelled or on hold) and its current stage is past its planned time. */
export const OVERDUE_SQL = `(r.status IN ('open','in_progress','pending_action','pending_approval','completed') AND r.current_stage_planned_at IS NOT NULL AND r.current_stage_planned_at < :now)`;

/** Row-level visibility for the signed-in user. */
export function scopeSql(user: AuthUser): { sql: string; params: Record<string, any> } {
  if (can(user.role, 'request.view_all')) return { sql: '1=1', params: {} };
  if (can(user.role, 'request.view_assigned')) {
    return {
      sql: `(r.assigned_engineer_id = :scope_eng OR r.site_engineer_id = :scope_eng OR r.created_by = :scope_user
             OR EXISTS (SELECT 1 FROM request_stages x WHERE x.request_id = r.id AND x.engineer_id = :scope_eng))`,
      params: { scope_eng: user.engineer_id ?? -1, scope_user: user.id },
    };
  }
  return { sql: 'r.created_by = :scope_user', params: { scope_user: user.id } };
}

export interface RequestFilters {
  property_id?: unknown; category_id?: unknown; status?: unknown; stage?: unknown; engineer_id?: unknown;
  priority?: unknown; from?: unknown; to?: unknown; overdue?: unknown; source?: unknown; q?: unknown;
  closed_from?: unknown; closed_to?: unknown;
}

export function buildFilter(f: RequestFilters, user: AuthUser) {
  const scope = scopeSql(user);
  const where = [scope.sql];
  const params: Record<string, any> = { ...scope.params, now: nowLocal() };
  const list = (v: unknown) => String(v).split(',').map((s) => s.trim()).filter(Boolean);
  const intList = (v: unknown) => list(v).map(Number).filter(Number.isInteger);
  const inClause = (col: string, values: (string | number)[], prefix: string) => {
    const names = values.map((v, i) => { params[`${prefix}${i}`] = v; return `:${prefix}${i}`; });
    where.push(`${col} IN (${names.join(',')})`);
  };
  if (f.property_id) inClause('r.property_id', intList(f.property_id), 'p');
  if (f.category_id) inClause('r.category_id', intList(f.category_id), 'c');
  if (f.status) {
    const statuses = list(f.status).filter((s) => REQUEST_STATUSES.some((x) => x.key === s) || s === 'active');
    const expanded = statuses.flatMap((s) => (s === 'active' ? OPEN_STATUSES : [s]));
    if (expanded.length) inClause('r.status', expanded, 's');
  }
  if (f.stage) inClause('r.current_stage_key', list(f.stage).filter((s) => STAGE_KEYS.includes(s as any)), 'st');
  if (f.priority) inClause('r.priority', list(f.priority).filter((s) => PRIORITIES.includes(s as any)), 'pr');
  if (f.engineer_id) {
    const e = int(f.engineer_id);
    if (e !== null) { where.push('(r.assigned_engineer_id = :eng OR r.site_engineer_id = :eng)'); params.eng = e; }
  }
  if (f.source === 'ui' || f.source === 'fms_import' || f.source === 'public') { where.push('r.source = :source'); params.source = f.source; }
  const from = normalizeLocal(f.from);
  const to = normalizeLocal(f.to);
  if (from) { where.push('r.requested_at >= :from'); params.from = from.slice(0, 10); }
  if (to) { where.push('r.requested_at <= :to'); params.to = `${to.slice(0, 10)}T23:59:59`; }
  const cfrom = normalizeLocal(f.closed_from);
  const cto = normalizeLocal(f.closed_to);
  if (cfrom) { where.push('r.completed_at >= :cfrom'); params.cfrom = cfrom.slice(0, 10); }
  if (cto) { where.push('r.completed_at <= :cto'); params.cto = `${cto.slice(0, 10)}T23:59:59`; }
  if (f.overdue === '1' || f.overdue === 'true' || f.overdue === true) where.push(OVERDUE_SQL);
  const q = str(f.q, 100);
  if (q) {
    where.push('(r.request_no LIKE :q OR r.title LIKE :q OR r.description LIKE :q OR r.requester_name LIKE :q OR r.property_no LIKE :q OR r.requester_email LIKE :q)');
    params.q = `%${q}%`;
  }
  return { where: where.join(' AND '), params };
}

export const LIST_SELECT = `
  SELECT r.id, r.request_no, r.source, r.title, r.priority, r.status, r.requested_at, r.target_date, r.location_detail, r.property_no, r.work_type,
         r.current_stage_key, r.current_stage_planned_at, r.completed_at, r.closed_at, r.hold_reason,
         r.property_id, p.name AS property_name, r.category_id, c.name AS category_name,
         r.assigned_engineer_id, e.name AS engineer_name, r.site_engineer_id, se.name AS site_engineer_name,
         CASE WHEN ${OVERDUE_SQL} THEN 1 ELSE 0 END AS is_overdue
  FROM requests r
  JOIN properties p ON p.id = r.property_id
  JOIN work_categories c ON c.id = r.category_id
  LEFT JOIN engineers e ON e.id = r.assigned_engineer_id
  LEFT JOIN engineers se ON se.id = r.site_engineer_id`;

const SORTS: Record<string, string> = {
  requested_at: 'r.requested_at', request_no: 'r.request_no', status: 'r.status', priority:
    "CASE r.priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END",
  planned: 'r.current_stage_planned_at', property: 'p.name', category: 'c.name', engineer: 'e.name',
};

export function decorate(r: Row, now = nowLocal()): Row {
  return {
    ...r,
    is_overdue: !!r.is_overdue,
    current_stage_name: stageName(r.current_stage_key),
    overdue_minutes: r.is_overdue ? diffMinutes(now, r.current_stage_planned_at) : null,
  };
}

export function listRequests(query: Record<string, any>, user: AuthUser) {
  const { where, params } = buildFilter(query, user);
  const page = Math.max(1, int(query.page) ?? 1);
  const pageSize = Math.min(500, Math.max(1, int(query.page_size) ?? 25));
  const sortKey = SORTS[query.sort as string] ? (query.sort as string) : 'requested_at';
  const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
  const total = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM requests r JOIN properties p ON p.id = r.property_id JOIN work_categories c ON c.id = r.category_id LEFT JOIN engineers e ON e.id = r.assigned_engineer_id WHERE ${where}`,
    params,
  )!.n;
  const rows = all(
    `${LIST_SELECT} WHERE ${where} ORDER BY ${SORTS[sortKey]} ${dir}, r.id DESC LIMIT :limit OFFSET :offset`,
    { ...params, limit: pageSize, offset: (page - 1) * pageSize },
  );
  const now = nowLocal();
  return { total, page, page_size: pageSize, rows: rows.map((r) => decorate(r, now)) };
}

export function exportRequests(query: Record<string, any>, user: AuthUser) {
  const { where, params } = buildFilter(query, user);
  const now = nowLocal();
  return all(`${LIST_SELECT} WHERE ${where} ORDER BY r.requested_at DESC LIMIT 50000`, params).map((r) => decorate(r, now));
}

export function loadRequest(id: number) {
  const r = get(
    `SELECT r.*, p.name AS property_name, c.name AS category_name, e.name AS engineer_name, se.name AS site_engineer_name,
            u.name AS created_by_name
     FROM requests r
     JOIN properties p ON p.id = r.property_id
     JOIN work_categories c ON c.id = r.category_id
     LEFT JOIN engineers e ON e.id = r.assigned_engineer_id
     LEFT JOIN engineers se ON se.id = r.site_engineer_id
     LEFT JOIN users u ON u.id = r.created_by
     WHERE r.id = ?`,
    [id],
  );
  if (!r) throw notFound('Job card');
  return r;
}

export function assertCanView(user: AuthUser, r: Row) {
  if (can(user.role, 'request.view_all')) return;
  if (can(user.role, 'request.view_assigned') && user.engineer_id) {
    if (r.assigned_engineer_id === user.engineer_id || r.site_engineer_id === user.engineer_id) return;
    if (get('SELECT 1 FROM request_stages WHERE request_id = ? AND engineer_id = ?', [r.id, user.engineer_id])) return;
  }
  if (r.created_by === user.id) return;
  throw forbidden('You do not have access to this job card');
}

export function getRequestDetail(id: number, user: AuthUser) {
  const r = loadRequest(id);
  assertCanView(user, r);
  const now = nowLocal();
  const defs = new Map(stageDefs().map((d) => [d.key, d]));
  const stages = all(
    `SELECT s.*, e.name AS engineer_name, u.name AS updated_by_name
     FROM request_stages s LEFT JOIN engineers e ON e.id = s.engineer_id LEFT JOIN users u ON u.id = s.updated_by
     WHERE s.request_id = ? ORDER BY s.seq`,
    [id],
  ).map((s) => {
    const d = defs.get(s.stage_key);
    const running = s.status === 'active' && s.planned_at && s.planned_at < now && r.status !== 'on_hold' ? diffMinutes(now, s.planned_at) : null;
    return {
      ...s,
      name: d?.name ?? s.stage_key,
      group: d?.group,
      optional: d?.optional ?? false,
      decision_stage: d?.decision ?? false,
      requires_evidence: d?.requiresEvidence ?? false,
      legacy: s.legacy ? JSON.parse(s.legacy) : null,
      running_delay_minutes: running,
      planned_inferred: !!s.planned_inferred,
      actual_inferred: !!s.actual_inferred,
    };
  });
  const attachments = all(
    `SELECT a.id, a.stage_key, a.kind, a.url, a.file_name, a.mime, a.size, a.caption, a.source, a.created_at, u.name AS uploaded_by_name
     FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by WHERE a.request_id = ? ORDER BY a.created_at, a.id`,
    [id],
  );
  const events = all('SELECT id, stage_key, type, message, data, user_name, created_at FROM request_events WHERE request_id = ? ORDER BY created_at DESC, id DESC', [id])
    .map((e) => ({ ...e, data: e.data ? JSON.parse(e.data) : null }));
  let legacy = null;
  if (r.source === 'fms_import') {
    const lr = get('SELECT l.row_no, l.cells, b.columns, b.file_name, b.id AS batch_id FROM legacy_rows l JOIN import_batches b ON b.id = l.batch_id WHERE l.request_id = ?', [id]);
    if (lr) {
      const cells: string[] = JSON.parse(lr.cells);
      const columns: { index: number; group: string; header: string }[] = JSON.parse(lr.columns ?? '[]');
      legacy = {
        batch_id: lr.batch_id, file_name: lr.file_name, row_no: lr.row_no,
        cells: cells.map((value, i) => ({ index: i + 1, group: columns[i]?.group ?? '', header: columns[i]?.header ?? '', value })),
      };
    }
  }
  const isOverdue = OPEN_STATUSES.includes(r.status) && !!r.current_stage_planned_at && r.current_stage_planned_at < now;
  return {
    request: { ...r, current_stage_name: stageName(r.current_stage_key), is_overdue: isOverdue, overdue_minutes: isOverdue ? diffMinutes(now, r.current_stage_planned_at) : null },
    stages,
    attachments,
    events,
    legacy,
  };
}

function resolveRef(table: 'properties' | 'work_categories' | 'engineers', id: unknown, label: string, required: boolean): number | null {
  const n = int(id);
  if (n === null) {
    if (required) throw badRequest(`${label} is required`);
    return null;
  }
  if (!get(`SELECT 1 FROM ${table} WHERE id = ? AND active = 1`, [n])) throw badRequest(`${label} not found or inactive`);
  return n;
}

export interface UploadedImage { filename: string; originalname: string; mimetype: string; size: number }

export const IMAGE_MIME = /^image\/(jpeg|png|gif|webp|heic|heif)$/;

/**
 * Shared creation path for signed-in users and the public form.
 * At least one location image (uploaded file or link) is compulsory.
 */
export function createRequest(
  body: any,
  user: AuthUser | null,
  images: UploadedImage[] = [],
  opts: { source?: 'ui' | 'public'; ip?: string | null } = {},
) {
  const source = opts.source ?? 'ui';
  const propertyId = resolveRef('properties', body.property_id, 'Property', true)!;
  const categoryId = resolveRef('work_categories', body.category_id, 'Work category', true)!;
  const description = requiredStr(body.description, 'Description', 5000);
  if (description.length < 10) throw badRequest('Please describe the problem in a little more detail');
  const title = str(body.title, 150) ?? description.replace(/\s+/g, ' ').slice(0, 80);
  const cat = get('SELECT default_priority FROM work_categories WHERE id = ?', [categoryId]);
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

  return tx(() => {
    const year = requestedAt.slice(0, 4);
    const requestNo = `JC-${year}-${String(nextSequence(`jobcard-${year}`)).padStart(6, '0')}`;
    const token = source === 'public' ? randomBytes(18).toString('base64url') : null;
    const { lastInsertRowid: id } = run(
      `INSERT INTO requests (request_no, source, title, description, property_id, category_id, priority, location_detail, requested_at,
         requester_name, requester_contact, requester_email, work_type, property_no, reason, created_by, target_date, status, public_token, requester_ip, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      [requestNo, source, title, description, propertyId, categoryId, priority, str(body.location_detail, 300), requestedAt,
        requesterName, contact, email, workType, propertyNo, reason, user?.id ?? null, target, token, opts.ip ?? null, requestedAt, requestedAt],
    );
    createStageRows(id, requestedAt, user?.id ?? null, requesterName);
    images.forEach((f, i) => run(
      `INSERT INTO attachments (request_id, stage_key, kind, stored_name, file_name, mime, size, caption, source, uploaded_by, created_at)
       VALUES (?, 'created', 'file', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, f.filename, f.originalname.slice(0, 200), f.mimetype, f.size, images.length > 1 ? `Image of location ${i + 1}` : 'Image of location', source, user?.id ?? null, requestedAt],
    ));
    for (const u of urls) {
      run(`INSERT INTO attachments (request_id, stage_key, kind, url, caption, source, uploaded_by, created_at) VALUES (?, 'created', 'url', ?, 'Image of location', 'ui', ?, ?)`, [id, u, user?.id ?? null, requestedAt]);
    }
    logEvent(id, 'created', `Job card ${requestNo} raised${source === 'public' ? ' via public form' : ''}`, { stageKey: 'created', user, userName: requesterName ?? undefined });
    refreshRequestState(id);
    return { id, request_no: requestNo, tracking_token: token };
  });
}

const EDITABLE: Record<string, 'text' | 'priority' | 'date' | 'property' | 'category'> = {
  title: 'text', description: 'text', location_detail: 'text', property_no: 'text', reason: 'text', requester_email: 'text', requester_name: 'text', requester_contact: 'text',
  priority: 'priority', target_date: 'date', property_id: 'property', category_id: 'category',
};

export function updateRequest(id: number, body: any, user: AuthUser) {
  const r = loadRequest(id);
  if (!can(user.role, 'request.edit')) throw forbidden();
  const sets: string[] = [];
  const params: any[] = [];
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [field, kind] of Object.entries(EDITABLE)) {
    if (body[field] === undefined) continue;
    let value: unknown;
    if (kind === 'text') value = field === 'title' ? requiredStr(body[field], 'Title', 150) : str(body[field], 5000);
    else if (kind === 'priority') value = oneOf(body[field], PRIORITIES, 'Priority');
    else if (kind === 'date') value = normalizeLocal(body[field])?.slice(0, 10) ?? null;
    else if (kind === 'property') value = resolveRef('properties', body[field], 'Property', true);
    else value = resolveRef('work_categories', body[field], 'Work category', true);
    if (value === r[field]) continue;
    sets.push(`${field} = ?`);
    params.push(value);
    changes[field] = { from: r[field], to: value };
  }
  if (!sets.length) return;
  tx(() => {
    run(`UPDATE requests SET ${sets.join(', ')}, modified_in_app = 1, updated_at = ? WHERE id = ?`, [...params, nowLocal(), id]);
    logEvent(id, 'edited', `Updated ${Object.keys(changes).join(', ').replace(/_id\b/g, '')}`, { user, data: changes });
  });
}
