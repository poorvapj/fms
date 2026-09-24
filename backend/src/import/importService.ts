import { randomBytes } from 'node:crypto';
import type { AuthUser } from '../auth/auth.ts';
import { col, nextId, withId, type Doc } from '../db/mongo.ts';
import { deriveState, DEFAULT_STAGES, type StageKey } from '../domain/workflow.ts';
import { eventDoc } from '../services/events.ts';
import { ensureMasterByName } from '../services/masters.ts';
import { nextJobNumbers } from '../services/requests.ts';
import { blankStage, refreshState, type RequestDoc, type StageDoc } from '../services/workflowEngine.ts';
import { nowLocal } from '../utils/dates.ts';
import { badRequest, conflict, int, notFound } from '../utils/http.ts';
import { detectLayout, type Layout } from './layout.ts';
import { proposeMapping, TARGETS, validateMapping, type Mapping } from './mapping.ts';
import { parseDelimited } from './parser.ts';
import { DEFAULT_OPTIONS, transformRow, whoByStage, type ImportOptions, type Issue, type PlannedRecord } from './transform.ts';

/** Upload files are kept in MongoDB between wizard steps (so any server instance can continue the wizard). */
export const MAX_IMPORT_MB = 15;

function decode(buf: Buffer): string {
  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/�/g) ?? []).length;
  return bad > 5 ? buf.toString('latin1') : utf8;
}

async function loadUpload(id: string, user: AuthUser): Promise<{ text: string; meta: Doc }> {
  if (!/^[a-f0-9]{32}$/.test(id)) throw badRequest('Invalid upload id');
  const u = await col.importUploads().findOne({ _id: id });
  if (!u) throw notFound('Upload (it may have expired or already been imported)');
  if (u.uploaded_by !== user.id && user.role !== 'admin') throw notFound('Upload');
  return { text: u.text, meta: u };
}

function analyse(text: string): { rows: string[][]; delimiter: string; layout: Layout } {
  const { rows, delimiter } = parseDelimited(text);
  if (rows.length < 2) throw badRequest('The file has no data rows');
  return { rows, delimiter, layout: detectLayout(rows) };
}

export async function saveUpload(file: { buffer: Buffer; originalname: string; size: number }, user: AuthUser) {
  if (!/\.(tsv|csv|txt)$/i.test(file.originalname)) throw badRequest('Upload a .tsv or .csv file');
  if (file.size > MAX_IMPORT_MB * 1024 * 1024) throw badRequest(`Import files are limited to ${MAX_IMPORT_MB} MB`);
  const id = randomBytes(16).toString('hex');
  const text = decode(file.buffer);
  analyse(text); // fail fast on unusable files
  await col.importUploads().insertOne({
    _id: id, text, file_name: file.originalname, size: file.size, uploaded_by: user.id, created_at: nowLocal(), created_at_date: new Date(),
  });
  return preview(id, user);
}

export async function preview(uploadId: string, user: AuthUser) {
  const { text, meta } = await loadUpload(uploadId, user);
  const { rows, delimiter, layout } = analyse(text);
  const width = layout.columns.length;
  return {
    upload_id: uploadId,
    file_name: meta.file_name,
    file_size: meta.size,
    delimiter: delimiter === '\t' ? 'tab' : delimiter,
    total_lines: rows.length,
    layout,
    head_rows: rows.slice(0, layout.data_start).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')),
    sample_rows: rows.slice(layout.data_start, layout.data_start + 12).map((r, i) => ({ row_no: layout.data_start + i + 1, cells: Array.from({ length: width }, (_, c) => r[c] ?? '') })),
    mapping: proposeMapping(layout),
    targets: TARGETS,
    default_options: DEFAULT_OPTIONS,
  };
}

function readOptions(o: any): ImportOptions {
  return {
    infer_planned: o?.infer_planned === undefined ? DEFAULT_OPTIONS.infer_planned : !!o.infer_planned,
    auto_create_masters: o?.auto_create_masters === undefined ? DEFAULT_OPTIONS.auto_create_masters : !!o.auto_create_masters,
    mode: o?.mode === 'update' ? 'update' : 'skip',
  };
}

type Action = 'create' | 'update' | 'skip_existing' | 'skip_modified' | 'skip_duplicate';
interface PlanItem { record: PlannedRecord; action: Action; existing_id?: number }


async function buildPlan(text: string, mapping: Mapping, options: ImportOptions) {
  const { rows, layout } = analyse(text);
  const mappingErrors = validateMapping(mapping, layout.columns.length);
  if (mappingErrors.length) throw badRequest('Column mapping is incomplete', mappingErrors);

  const who = whoByStage(layout.stages);
  const existing = new Map(
    (await col.requests().find({ legacy_key: { $type: 'string' } }, { projection: { legacy_key: 1, modified_in_app: 1 } }).toArray())
      .map((r) => [r.legacy_key as string, r]),
  );
  const names = async (c: ReturnType<typeof col.properties>) => new Set((await c.find({}, { projection: { name: 1 } }).toArray()).map((r) => String(r.name).toLowerCase()));
  const known = { properties: await names(col.properties()), work_categories: await names(col.categories()), engineers: await names(col.engineers()) };
  const toCreate = { properties: new Map<string, string>(), work_categories: new Map<string, string>(), engineers: new Map<string, string>() };

  const issues: Issue[] = [];
  const items: PlanItem[] = [];
  const seen = new Set<string>();
  let errorRows = 0;
  let totalRows = 0;

  for (let i = layout.data_start; i < rows.length; i++) {
    const cells = rows[i];
    if (!cells.some((c) => c.trim())) continue;
    totalRows++;
    const rowNo = i + 1;
    const { record, issues: rowIssues } = transformRow(cells, rowNo, mapping, options, who);
    issues.push(...rowIssues);
    if (!record) { errorRows++; continue; }

    const missing: string[] = [];
    const check = (table: keyof typeof known, name: string | null, label: string) => {
      if (!name) return;
      const k = name.toLowerCase();
      if (known[table].has(k) || toCreate[table].has(k)) return;
      if (options.auto_create_masters) toCreate[table].set(k, name);
      else missing.push(`${label} "${name}" does not exist`);
    };
    check('properties', record.property, 'Property');
    check('work_categories', record.category, 'Work category');
    for (const s of record.stages) check('engineers', s.engineer, 'Engineer');
    check('engineers', record.site_engineer, 'Engineer');
    check('engineers', record.assigned_engineer, 'Engineer');
    if (missing.length) {
      for (const m of missing) issues.push({ row_no: rowNo, severity: 'error', field: 'Masters', message: `${m} (enable auto-create or add it in Masters)` });
      errorRows++;
      continue;
    }

    if (seen.has(record.legacy_key)) {
      issues.push({ row_no: rowNo, severity: 'warning', field: 'Row', message: 'Duplicate of an earlier row in this file — skipped' });
      items.push({ record, action: 'skip_duplicate' });
      continue;
    }
    seen.add(record.legacy_key);
    const ex = existing.get(record.legacy_key);
    if (!ex) items.push({ record, action: 'create' });
    else if (options.mode === 'skip') items.push({ record, action: 'skip_existing', existing_id: ex._id });
    else if (ex.modified_in_app) {
      issues.push({ row_no: rowNo, severity: 'warning', field: 'Row', message: 'Already imported and changed in the app since — not overwritten' });
      items.push({ record, action: 'skip_modified', existing_id: ex._id });
    } else items.push({ record, action: 'update', existing_id: ex._id });
  }
  return { layout, issues, items, errorRows, totalRows, toCreate };
}

function outcomeStatus(rec: PlannedRecord) {
  return deriveState(
    rec.stages.map((s) => ({ stage_key: s.key, seq: DEFAULT_STAGES.find((d) => d.key === s.key)!.seq, status: s.status, planned_at: s.planned_at })),
    { held: !!rec.hold_reason, cancelled: !!rec.cancel_reason },
  ).status;
}

function summarise(plan: Awaited<ReturnType<typeof buildPlan>>) {
  const count = (a: Action) => plan.items.filter((i) => i.action === a).length;
  const warningRows = new Set(plan.issues.filter((i) => i.severity === 'warning').map((i) => i.row_no)).size;
  const grouped = new Map<string, { severity: string; field: string; message: string; count: number; rows: number[] }>();
  for (const i of plan.issues) {
    const k = `${i.severity}|${i.field}|${i.message}`;
    const g = grouped.get(k) ?? { severity: i.severity, field: i.field, message: i.message, count: 0, rows: [] };
    g.count++;
    if (g.rows.length < 15) g.rows.push(i.row_no);
    grouped.set(k, g);
  }
  const outcomes: Record<string, number> = {};
  for (const it of plan.items.filter((i) => i.action === 'create' || i.action === 'update')) {
    const s = outcomeStatus(it.record);
    outcomes[s] = (outcomes[s] ?? 0) + 1;
  }
  return {
    total_rows: plan.totalRows,
    error_rows: plan.errorRows,
    warning_rows: warningRows,
    create: count('create'),
    update: count('update'),
    skip_existing: count('skip_existing'),
    skip_modified: count('skip_modified'),
    skip_duplicate: count('skip_duplicate'),
    error_count: plan.issues.filter((i) => i.severity === 'error').length,
    warning_count: plan.issues.filter((i) => i.severity === 'warning').length,
    masters_to_create: {
      properties: [...plan.toCreate.properties.values()].sort(),
      categories: [...plan.toCreate.work_categories.values()].sort(),
      engineers: [...plan.toCreate.engineers.values()].sort(),
    },
    outcome_status: outcomes,
    issue_groups: [...grouped.values()].sort((a, b) => (a.severity === b.severity ? b.count - a.count : a.severity === 'error' ? -1 : 1)),
  };
}

export async function validateImport(uploadId: string, body: any, user: AuthUser) {
  const { text } = await loadUpload(uploadId, user);
  const plan = await buildPlan(text, body.mapping ?? {}, readOptions(body.options));
  const samples = plan.items.filter((i) => i.action === 'create' || i.action === 'update').slice(0, 5).map((i) => ({
    row_no: i.record.row_no,
    requested_at: i.record.requested_at,
    property: i.record.property,
    category: i.record.category,
    title: i.record.title,
    engineer: i.record.assigned_engineer,
    status: outcomeStatus(i.record),
    stages: i.record.stages.map((s) => ({
      key: s.key, name: DEFAULT_STAGES.find((d) => d.key === s.key)!.name, status: s.status, planned_at: s.planned_at, actual_at: s.actual_at,
      delay_minutes: s.delay_minutes, planned_inferred: s.planned_inferred, actual_inferred: s.actual_inferred, engineer: s.engineer,
    })),
  }));
  return { summary: summarise(plan), issues: plan.issues.slice(0, 3000), samples };
}

export async function commitImport(uploadId: string, body: any, user: AuthUser) {
  const { text, meta } = await loadUpload(uploadId, user);
  const options = readOptions(body.options);
  const mapping: Mapping = body.mapping ?? {};
  const plan = await buildPlan(text, mapping, options);
  const summary = summarise(plan);
  if (!summary.create && !summary.update) throw conflict('Nothing to import — every row is an error or already imported');
  const now = nowLocal();
  const heldAt = plan.layout.export_at ?? now;
  const work = plan.items.filter((i) => i.action === 'create' || i.action === 'update');

  const batchId = await nextId('import_batches');
  await col.batches().insertOne({
    _id: batchId, file_name: meta.file_name, file_size: meta.size, export_at: plan.layout.export_at, mode: options.mode, options, mapping,
    columns: plan.layout.columns.map((c) => ({ index: c.index, letter: c.letter, group: c.group, header: c.header })),
    total_rows: plan.totalRows, created_count: 0, updated_count: 0, skipped_count: 0, error_count: 0, warning_count: 0,
    summary: null, status: 'in_progress', created_by: user.id, created_at: now, rolled_back_at: null,
  });

  try {
    // Masters (find or create, once per name)
    const ids = { properties: new Map<string, number>(), work_categories: new Map<string, number>(), engineers: new Map<string, number>() };
    const idOf = async (table: keyof typeof ids, name: string | null): Promise<number | null> => {
      if (!name) return null;
      const k = name.toLowerCase();
      let id = ids[table].get(k);
      if (id === undefined) {
        id = (await ensureMasterByName(table, name, table === 'engineers' && /external/i.test(name) ? { is_external: 1 } : {})).id;
        ids[table].set(k, id);
      }
      return id;
    };

    // Reserve ids and job numbers in blocks
    const creates = work.filter((i) => i.action === 'create');
    const firstRequestId = creates.length ? await nextId('requests', creates.length) : 0;
    const byYear = new Map<string, PlanItem[]>();
    for (const it of creates) byYear.set(it.record.requested_at.slice(0, 4), [...(byYear.get(it.record.requested_at.slice(0, 4)) ?? []), it]);
    const jobNo = new Map<PlanItem, string>();
    for (const [year, list] of byYear) {
      const nos = await nextJobNumbers(year, list.length);
      list.forEach((it, i) => jobNo.set(it, nos[i]));
    }
    const attCount = work.reduce((n, it) => n + it.record.location_images.length + it.record.completion_images.length, 0);
    let attId = attCount ? await nextId('attachments', attCount) : 0;
    let evId = await nextId('request_events', work.length);

    const newDocs: RequestDoc[] = [];
    const attachments: Doc[] = [];
    const legacy: Doc[] = [];
    const events: Doc[] = [];
    const updates: RequestDoc[] = [];
    let createdIdx = 0;

    for (const item of work) {
      const rec = item.record;
      const stages: StageDoc[] = [];
      for (const s of rec.stages) {
        const def = DEFAULT_STAGES.find((d) => d.key === s.key)!;
        const st = blankStage(s.key as StageKey, def.seq, now);
        Object.assign(st, {
          status: s.status, planned_at: s.planned_at, actual_at: s.actual_at, delay_minutes: s.delay_minutes, responsible_role: def.responsibleLabel,
          responsible_name: s.responsible_name, engineer_id: await idOf('engineers', s.engineer), decision: def.decision && s.status === 'completed' ? 'approved' : null,
          comments: s.comments, planned_inferred: s.planned_inferred, actual_inferred: s.actual_inferred, source: 'fms_import', legacy: s.legacy,
        });
        stages.push(st);
      }
      const fields = {
        title: rec.title, description: rec.description, property_id: await idOf('properties', rec.property), category_id: await idOf('work_categories', rec.category),
        priority: rec.priority, requested_at: rec.requested_at, requester_name: rec.requester_name, requester_email: rec.requester_email,
        work_type: rec.work_type, property_no: rec.property_no, reason: rec.reason, target_date: rec.target_date,
        site_engineer_id: await idOf('engineers', rec.site_engineer), assigned_engineer_id: await idOf('engineers', rec.assigned_engineer),
        requires_ph_discussion: rec.stages.some((s) => s.key === 'ph_discussion' && s.status !== 'skipped') ? 1 : 0,
        requires_material: rec.stages.some((s) => s.key === 'material' && s.status !== 'skipped') ? 1 : 0,
        requires_permission: rec.stages.some((s) => s.key === 'permission' && s.status !== 'skipped') ? 1 : 0,
        held_at: rec.hold_reason ? heldAt : null, hold_reason: rec.hold_reason, cancelled_at: rec.cancel_reason ? heldAt : null, cancel_reason: rec.cancel_reason,
        closure_category: rec.closure_category, closure_note: rec.closure_note, verified_by_name: rec.verified_by_name, import_row_no: rec.row_no,
        stages, updated_at: now,
      };
      let requestId: number;
      if (item.action === 'create') {
        requestId = firstRequestId + createdIdx++;
        const doc = {
          _id: requestId, request_no: jobNo.get(item)!, source: 'fms_import', legacy_key: rec.legacy_key, import_batch_id: batchId,
          location_detail: null, requester_contact: null, created_by: user.id, public_token: null, requester_ip: null,
          status: 'open', current_stage_key: null, current_stage_planned_at: null, completed_at: null, closed_at: null,
          modified_in_app: false, version: 1, created_at: now, ...fields,
        } as RequestDoc;
        refreshState(doc, { rollForward: false });
        newDocs.push(doc);
        events.push(eventDoc(evId++, requestId, 'imported', `Imported from FMS "${meta.file_name}" (sheet row ${rec.row_no}, batch #${batchId})`, { user, at: now }));
      } else {
        requestId = item.existing_id!;
        const existing = (await col.requests().findOne({ _id: requestId })) as RequestDoc;
        const doc = { ...existing, ...fields, version: (existing.version ?? 0) + 1 } as RequestDoc;
        refreshState(doc, { rollForward: false });
        updates.push(doc);
        events.push(eventDoc(evId++, requestId, 'imported', `Refreshed from FMS "${meta.file_name}" (sheet row ${rec.row_no}, batch #${batchId})`, { user, at: now }));
      }
      rec.location_images.forEach((u, i) => attachments.push({
        _id: attId++, request_id: requestId, stage_key: 'created', kind: 'url', url: u,
        caption: rec.location_images.length > 1 ? `Image of location ${i + 1}` : 'Image of location', source: 'fms_import', uploaded_by: null, created_at: rec.requested_at,
      }));
      const wcAt = rec.stages.find((s) => s.key === 'work_completed')?.actual_at;
      rec.completion_images.forEach((u, i) => attachments.push({
        _id: attId++, request_id: requestId, stage_key: 'work_completed', kind: 'url', url: u,
        caption: rec.completion_images.length > 1 ? `Completion image ${i + 1}` : 'Completion image', source: 'fms_import', uploaded_by: null, created_at: wcAt ?? rec.requested_at,
      }));
      legacy.push({ _id: requestId, request_id: requestId, batch_id: batchId, row_no: rec.row_no, cells: rec.cells });
    }

    const updatedIds = updates.map((u) => u._id);
    if (updatedIds.length) {
      await col.attachments().deleteMany({ request_id: { $in: updatedIds }, source: 'fms_import' });
      await col.legacyRows().deleteMany({ request_id: { $in: updatedIds } });
      for (const u of updates) await col.requests().replaceOne({ _id: u._id }, u);
    }
    const CHUNK = 500;
    for (let i = 0; i < newDocs.length; i += CHUNK) await col.requests().insertMany(newDocs.slice(i, i + CHUNK), { ordered: false });
    for (let i = 0; i < attachments.length; i += CHUNK) await col.attachments().insertMany(attachments.slice(i, i + CHUNK), { ordered: false });
    for (let i = 0; i < legacy.length; i += CHUNK) await col.legacyRows().insertMany(legacy.slice(i, i + CHUNK), { ordered: false });
    for (let i = 0; i < events.length; i += CHUNK) await col.events().insertMany(events.slice(i, i + CHUNK), { ordered: false });
    if (plan.issues.length) {
      const firstIssue = await nextId('import_issues', plan.issues.length);
      const docs = plan.issues.map((iss, k) => ({ _id: firstIssue + k, batch_id: batchId, row_no: iss.row_no, severity: iss.severity, field: iss.field, message: iss.message, value: iss.value?.slice(0, 500) ?? null }));
      for (let i = 0; i < docs.length; i += CHUNK) await col.issues().insertMany(docs.slice(i, i + CHUNK), { ordered: false });
    }

    const skipped = summary.skip_existing + summary.skip_modified + summary.skip_duplicate;
    const finalSummary = { ...summary, created: newDocs.length, updated: updates.length, masters_created: summary.masters_to_create };
    await col.batches().updateOne({ _id: batchId }, {
      $set: {
        status: 'committed', created_count: newDocs.length, updated_count: updates.length, skipped_count: skipped,
        error_count: summary.error_rows, warning_count: summary.warning_rows, summary: finalSummary,
      },
    });
    await col.importUploads().deleteOne({ _id: uploadId });
    return { batch_id: batchId, ...finalSummary };
  } catch (err) {
    // Undo a partial import so the batch can simply be retried.
    const created = await col.requests().find({ import_batch_id: batchId }, { projection: { _id: 1 } }).toArray();
    const createdIds = created.map((c) => c._id);
    await Promise.all([
      col.requests().deleteMany({ import_batch_id: batchId }),
      col.attachments().deleteMany({ request_id: { $in: createdIds }, source: 'fms_import' }),
      col.legacyRows().deleteMany({ batch_id: batchId }),
      col.events().deleteMany({ request_id: { $in: createdIds } }),
      col.issues().deleteMany({ batch_id: batchId }),
    ]);
    await col.batches().updateOne({ _id: batchId }, { $set: { status: 'failed', error: String((err as Error)?.message ?? err) } });
    throw err;
  }
}

export async function listBatches() {
  const [batches, users] = await Promise.all([
    col.batches().find({ status: { $ne: 'failed' } }, { projection: { mapping: 0, columns: 0, options: 0, summary: 0 } }).sort({ _id: -1 }).toArray(),
    col.users().find({}, { projection: { name: 1 } }).toArray(),
  ]);
  const names = new Map(users.map((u) => [u._id, u.name]));
  return batches.map((b) => ({ ...withId(b), created_by_name: names.get(b.created_by) ?? null }));
}

export async function getBatch(id: number, query: Record<string, any>) {
  const b = await col.batches().findOne({ _id: id });
  if (!b) throw notFound('Import batch');
  const severity = query.severity === 'error' || query.severity === 'warning' ? query.severity : null;
  const page = Math.max(1, int(query.page) ?? 1);
  const size = 200;
  const filter = severity ? { batch_id: id, severity } : { batch_id: id };
  const [issues, issueTotal, statusRows, modified, creator] = await Promise.all([
    col.issues().find(filter, { projection: { _id: 0, batch_id: 0 } }).sort({ row_no: 1, _id: 1 }).skip((page - 1) * size).limit(size).toArray(),
    col.issues().countDocuments(filter),
    col.requests().aggregate([{ $match: { import_batch_id: id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
    col.requests().countDocuments({ import_batch_id: id, modified_in_app: true }),
    col.users().findOne({ _id: b.created_by }, { projection: { name: 1 } }),
  ]);
  const { mapping: _m, columns: _c, ...rest } = b;
  return {
    batch: { ...withId(rest), created_by_name: creator?.name ?? null },
    issues, issue_total: issueTotal, page, page_size: size,
    status_counts: statusRows.map((s) => ({ status: s._id, n: s.n })), modified_records: modified,
    can_rollback: b.status === 'committed' && !b.updated_count && modified === 0,
  };
}

export async function rollbackBatch(id: number, user: AuthUser) {
  const b = await col.batches().findOne({ _id: id });
  if (!b) throw notFound('Import batch');
  if (b.status !== 'committed') throw conflict('Batch is already rolled back');
  if (b.updated_count) throw conflict('This batch refreshed existing records and cannot be rolled back');
  const modified = await col.requests().countDocuments({ import_batch_id: id, modified_in_app: true });
  if (modified) throw conflict(`${modified} record(s) from this batch have been worked on in the app; rollback is not allowed`);
  const ids = (await col.requests().find({ import_batch_id: id }, { projection: { _id: 1 } }).toArray()).map((r) => r._id);
  const { deletedCount } = await col.requests().deleteMany({ import_batch_id: id });
  await Promise.all([
    col.attachments().deleteMany({ request_id: { $in: ids } }),
    col.legacyRows().deleteMany({ request_id: { $in: ids } }),
    col.events().deleteMany({ request_id: { $in: ids } }),
  ]);
  await col.batches().updateOne({ _id: id }, { $set: { status: 'rolled_back', rolled_back_at: nowLocal() } });
  return { removed: deletedCount, by: user.name };
}
