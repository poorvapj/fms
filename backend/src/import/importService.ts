import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AuthUser } from '../auth/auth.ts';
import { config } from '../config.ts';
import { all, get, nextSequence, run, tx } from '../db/db.ts';
import { deriveState, DEFAULT_STAGES, type StageKey } from '../domain/workflow.ts';
import { logEvent } from '../services/events.ts';
import { ensureMasterByName } from '../services/masters.ts';
import { refreshRequestState } from '../services/workflowEngine.ts';
import { nowLocal } from '../utils/dates.ts';
import { badRequest, conflict, int, notFound } from '../utils/http.ts';
import { detectLayout, type Layout } from './layout.ts';
import { proposeMapping, TARGETS, validateMapping, type Mapping } from './mapping.ts';
import { parseDelimited } from './parser.ts';
import { DEFAULT_OPTIONS, transformRow, whoByStage, type ImportOptions, type Issue, type PlannedRecord } from './transform.ts';

interface UploadMeta { id: string; file_name: string; size: number; uploaded_by: number; created_at: string }

const uploadPath = (id: string, ext: string) => {
  if (!/^[a-f0-9]{32}$/.test(id)) throw badRequest('Invalid upload id');
  return path.join(config.importsDir, `${id}.${ext}`);
};

function decode(buf: Buffer): string {
  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/�/g) ?? []).length;
  return bad > 5 ? buf.toString('latin1') : utf8;
}

function loadUpload(id: string, user: AuthUser): { text: string; meta: UploadMeta } {
  const metaFile = uploadPath(id, 'json');
  if (!existsSync(metaFile)) throw notFound('Upload (it may have expired or already been imported)');
  const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as UploadMeta;
  if (meta.uploaded_by !== user.id && user.role !== 'admin') throw notFound('Upload');
  return { text: readFileSync(uploadPath(id, 'txt'), 'utf8'), meta };
}

function analyse(text: string): { rows: string[][]; delimiter: string; layout: Layout } {
  const { rows, delimiter } = parseDelimited(text);
  if (rows.length < 2) throw badRequest('The file has no data rows');
  return { rows, delimiter, layout: detectLayout(rows) };
}

export function saveUpload(file: { buffer: Buffer; originalname: string; size: number }, user: AuthUser) {
  if (!/\.(tsv|csv|txt)$/i.test(file.originalname)) throw badRequest('Upload a .tsv or .csv file');
  const id = randomBytes(16).toString('hex');
  const text = decode(file.buffer);
  analyse(text); // fail fast on unusable files
  writeFileSync(uploadPath(id, 'txt'), text, 'utf8');
  const meta: UploadMeta = { id, file_name: file.originalname, size: file.size, uploaded_by: user.id, created_at: nowLocal() };
  writeFileSync(uploadPath(id, 'json'), JSON.stringify(meta));
  return preview(id, user);
}

export function preview(uploadId: string, user: AuthUser) {
  const { text, meta } = loadUpload(uploadId, user);
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

function buildPlan(text: string, mapping: Mapping, options: ImportOptions) {
  const { rows, layout } = analyse(text);
  const mappingErrors = validateMapping(mapping, layout.columns.length);
  if (mappingErrors.length) throw badRequest('Column mapping is incomplete', mappingErrors);

  const who = whoByStage(layout.stages);
  const existing = new Map(all('SELECT legacy_key, id, modified_in_app FROM requests WHERE legacy_key IS NOT NULL').map((r) => [r.legacy_key, r]));
  const names = (table: string) => new Set(all(`SELECT name FROM ${table}`).map((r) => String(r.name).toLowerCase()));
  const known = { properties: names('properties'), work_categories: names('work_categories'), engineers: names('engineers') };
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
    else if (options.mode === 'skip') items.push({ record, action: 'skip_existing', existing_id: ex.id });
    else if (ex.modified_in_app) {
      issues.push({ row_no: rowNo, severity: 'warning', field: 'Row', message: 'Already imported and changed in the app since — not overwritten' });
      items.push({ record, action: 'skip_modified', existing_id: ex.id });
    } else items.push({ record, action: 'update', existing_id: ex.id });
  }
  return { layout, issues, items, errorRows, totalRows, toCreate };
}

function outcomeStatus(rec: PlannedRecord) {
  return deriveState(
    rec.stages.map((s) => ({ stage_key: s.key, seq: DEFAULT_STAGES.find((d) => d.key === s.key)!.seq, status: s.status, planned_at: s.planned_at })),
    { held: !!rec.hold_reason, cancelled: !!rec.cancel_reason },
  ).status;
}

function summarise(plan: ReturnType<typeof buildPlan>) {
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

export function validateImport(uploadId: string, body: any, user: AuthUser) {
  const { text } = loadUpload(uploadId, user);
  const plan = buildPlan(text, body.mapping ?? {}, readOptions(body.options));
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

export function commitImport(uploadId: string, body: any, user: AuthUser) {
  const { text, meta } = loadUpload(uploadId, user);
  const options = readOptions(body.options);
  const mapping: Mapping = body.mapping ?? {};
  const plan = buildPlan(text, mapping, options);
  const summary = summarise(plan);
  if (!summary.create && !summary.update) throw conflict('Nothing to import — every row is an error or already imported');
  const now = nowLocal();
  const heldAt = plan.layout.export_at ?? now;

  const result = tx(() => {
    const batchId = run(
      `INSERT INTO import_batches (file_name, file_size, export_at, mode, options, mapping, columns, total_rows, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [meta.file_name, meta.size, plan.layout.export_at, options.mode, JSON.stringify(options), JSON.stringify(mapping),
        JSON.stringify(plan.layout.columns.map((c) => ({ index: c.index, letter: c.letter, group: c.group, header: c.header }))), plan.totalRows, user.id, now],
    ).lastInsertRowid;

    const ids = { properties: new Map<string, number>(), work_categories: new Map<string, number>(), engineers: new Map<string, number>() };
    const idOf = (table: keyof typeof ids, name: string | null): number | null => {
      if (!name) return null;
      const k = name.toLowerCase();
      let id = ids[table].get(k);
      if (id === undefined) {
        id = ensureMasterByName(table, name, table === 'engineers' && /external/i.test(name) ? { is_external: 1 } : {}).id;
        ids[table].set(k, id);
      }
      return id;
    };

    let created = 0;
    let updated = 0;
    for (const item of plan.items) {
      if (item.action !== 'create' && item.action !== 'update') continue;
      const rec = item.record;
      const propertyId = idOf('properties', rec.property)!;
      const categoryId = idOf('work_categories', rec.category)!;
      const siteEng = idOf('engineers', rec.site_engineer);
      const assignedEng = idOf('engineers', rec.assigned_engineer);
      const fields = [
        rec.title, rec.description, propertyId, categoryId, rec.priority, rec.requested_at, rec.requester_name, rec.target_date,
        siteEng, assignedEng,
        rec.stages.some((s) => s.key === 'ph_discussion' && s.status !== 'skipped') ? 1 : 0,
        rec.stages.some((s) => s.key === 'material' && s.status !== 'skipped') ? 1 : 0,
        rec.stages.some((s) => s.key === 'permission' && s.status !== 'skipped') ? 1 : 0,
        rec.hold_reason ? heldAt : null, rec.hold_reason, rec.cancel_reason ? heldAt : null, rec.cancel_reason,
        rec.closure_category, rec.closure_note, rec.verified_by_name, rec.row_no,
        rec.requester_email, rec.work_type, rec.property_no, rec.reason,
      ];
      let requestId: number;
      if (item.action === 'create') {
        const year = rec.requested_at.slice(0, 4);
        const requestNo = `JC-${year}-${String(nextSequence(`jobcard-${year}`)).padStart(6, '0')}`;
        requestId = run(
          `INSERT INTO requests (title, description, property_id, category_id, priority, requested_at, requester_name, target_date,
             site_engineer_id, assigned_engineer_id, requires_ph_discussion, requires_material, requires_permission,
             held_at, hold_reason, cancelled_at, cancel_reason, closure_category, closure_note, verified_by_name, import_row_no,
             requester_email, work_type, property_no, reason,
             request_no, source, status, legacy_key, import_batch_id, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fms_import', 'open', ?, ?, ?, ?, ?)`,
          [...fields, requestNo, rec.legacy_key, batchId, user.id, now, now],
        ).lastInsertRowid;
        created++;
        logEvent(requestId, 'imported', `Imported from FMS "${meta.file_name}" (sheet row ${rec.row_no}, batch #${batchId})`, { user, at: now });
      } else {
        requestId = item.existing_id!;
        run(
          `UPDATE requests SET title = ?, description = ?, property_id = ?, category_id = ?, priority = ?, requested_at = ?, requester_name = ?, target_date = ?,
             site_engineer_id = ?, assigned_engineer_id = ?, requires_ph_discussion = ?, requires_material = ?, requires_permission = ?,
             held_at = ?, hold_reason = ?, cancelled_at = ?, cancel_reason = ?, closure_category = ?, closure_note = ?, verified_by_name = ?, import_row_no = ?,
             requester_email = ?, work_type = ?, property_no = ?, reason = ?, updated_at = ? WHERE id = ?`,
          [...fields, now, requestId],
        );
        run('DELETE FROM request_stages WHERE request_id = ?', [requestId]);
        run(`DELETE FROM attachments WHERE request_id = ? AND source = 'fms_import'`, [requestId]);
        run('DELETE FROM legacy_rows WHERE request_id = ?', [requestId]);
        updated++;
        logEvent(requestId, 'imported', `Refreshed from FMS "${meta.file_name}" (sheet row ${rec.row_no}, batch #${batchId})`, { user, at: now });
      }

      for (const s of rec.stages) {
        const def = DEFAULT_STAGES.find((d) => d.key === s.key)!;
        run(
          `INSERT INTO request_stages (request_id, stage_key, seq, status, planned_at, actual_at, delay_minutes, responsible_role, responsible_name,
             engineer_id, decision, comments, planned_inferred, actual_inferred, source, legacy, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fms_import', ?, ?)`,
          [requestId, s.key, def.seq, s.status, s.planned_at, s.actual_at, s.delay_minutes, def.responsibleLabel, s.responsible_name,
            idOf('engineers', s.engineer), def.decision && s.status === 'completed' ? 'approved' : null, s.comments,
            s.planned_inferred ? 1 : 0, s.actual_inferred ? 1 : 0, s.legacy ? JSON.stringify(s.legacy) : null, now],
        );
      }
      const attach = (stage: StageKey, url: string, caption: string) =>
        run(`INSERT INTO attachments (request_id, stage_key, kind, url, caption, source, created_at) VALUES (?, ?, 'url', ?, ?, 'fms_import', ?)`,
          [requestId, stage, url, caption, rec.requested_at]);
      rec.location_images.forEach((u, i) => attach('created', u, rec.location_images.length > 1 ? `Image of location ${i + 1}` : 'Image of location'));
      const wcAt = rec.stages.find((s) => s.key === 'work_completed')?.actual_at;
      rec.completion_images.forEach((u, i) => {
        run(`INSERT INTO attachments (request_id, stage_key, kind, url, caption, source, created_at) VALUES (?, 'work_completed', 'url', ?, ?, 'fms_import', ?)`,
          [requestId, u, rec.completion_images.length > 1 ? `Completion image ${i + 1}` : 'Completion image', wcAt ?? rec.requested_at]);
      });
      run('INSERT INTO legacy_rows (request_id, batch_id, row_no, cells) VALUES (?, ?, ?, ?)', [requestId, batchId, rec.row_no, JSON.stringify(rec.cells)]);
      refreshRequestState(requestId, { rollForward: false });
    }

    for (const i of plan.issues) {
      run('INSERT INTO import_issues (batch_id, row_no, severity, field, message, value) VALUES (?, ?, ?, ?, ?, ?)',
        [batchId, i.row_no, i.severity, i.field, i.message, i.value?.slice(0, 500) ?? null]);
    }
    const skipped = summary.skip_existing + summary.skip_modified + summary.skip_duplicate;
    const finalSummary = { ...summary, created, updated, masters_created: summary.masters_to_create };
    run(
      `UPDATE import_batches SET created_count = ?, updated_count = ?, skipped_count = ?, error_count = ?, warning_count = ?, summary = ? WHERE id = ?`,
      [created, updated, skipped, summary.error_rows, summary.warning_rows, JSON.stringify(finalSummary), batchId],
    );
    return { batch_id: batchId, ...finalSummary };
  });

  for (const ext of ['txt', 'json']) {
    try { unlinkSync(uploadPath(uploadId, ext)); } catch { /* ignore */ }
  }
  return result;
}

export function listBatches() {
  return all(`SELECT b.id, b.file_name, b.file_size, b.export_at, b.mode, b.total_rows, b.created_count, b.updated_count, b.skipped_count,
      b.error_count, b.warning_count, b.status, b.created_at, b.rolled_back_at, u.name AS created_by_name
    FROM import_batches b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.id DESC`);
}

export function getBatch(id: number, query: Record<string, any>) {
  const b = get('SELECT b.*, u.name AS created_by_name FROM import_batches b LEFT JOIN users u ON u.id = b.created_by WHERE b.id = ?', [id]);
  if (!b) throw notFound('Import batch');
  const severity = query.severity === 'error' || query.severity === 'warning' ? query.severity : null;
  const page = Math.max(1, int(query.page) ?? 1);
  const size = 200;
  const where = severity ? 'batch_id = ? AND severity = ?' : 'batch_id = ?';
  const params = severity ? [id, severity] : [id];
  const issues = all(`SELECT row_no, severity, field, message, value FROM import_issues WHERE ${where} ORDER BY row_no, id LIMIT ${size} OFFSET ${(page - 1) * size}`, params);
  const issueTotal = get<{ n: number }>(`SELECT COUNT(*) AS n FROM import_issues WHERE ${where}`, params)!.n;
  const statusCounts = all('SELECT status, COUNT(*) AS n FROM requests WHERE import_batch_id = ? GROUP BY status', [id]);
  const modified = get<{ n: number }>('SELECT COUNT(*) AS n FROM requests WHERE import_batch_id = ? AND modified_in_app = 1', [id])!.n;
  return {
    batch: { ...b, options: JSON.parse(b.options ?? '{}'), summary: JSON.parse(b.summary ?? '{}'), mapping: undefined, columns: undefined },
    issues, issue_total: issueTotal, page, page_size: size,
    status_counts: statusCounts, modified_records: modified,
    can_rollback: b.status === 'committed' && !b.updated_count && modified === 0,
  };
}

export function rollbackBatch(id: number, user: AuthUser) {
  const b = get('SELECT * FROM import_batches WHERE id = ?', [id]);
  if (!b) throw notFound('Import batch');
  if (b.status !== 'committed') throw conflict('Batch is already rolled back');
  if (b.updated_count) throw conflict('This batch refreshed existing records and cannot be rolled back');
  const modified = get<{ n: number }>('SELECT COUNT(*) AS n FROM requests WHERE import_batch_id = ? AND modified_in_app = 1', [id])!.n;
  if (modified) throw conflict(`${modified} record(s) from this batch have been worked on in the app; rollback is not allowed`);
  return tx(() => {
    const { changes } = run('DELETE FROM requests WHERE import_batch_id = ?', [id]);
    run('UPDATE import_batches SET status = ?, rolled_back_at = ? WHERE id = ?', ['rolled_back', nowLocal(), id]);
    return { removed: changes, by: user.name };
  });
}
