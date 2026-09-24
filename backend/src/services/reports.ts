import type { AuthUser } from '../auth/auth.ts';
import { all } from '../db/db.ts';
import { LEGACY_STAGE_KEYS } from '../domain/workflow.ts';
import { diffMinutes, nowLocal } from '../utils/dates.ts';
import { notFound } from '../utils/http.ts';
import { buildFilter, OVERDUE_SQL } from './requests.ts';
import { stageDefs, stageName } from './stageDefs.ts';

export type ColType = 'text' | 'number' | 'datetime' | 'date' | 'hours' | 'percent' | 'request' | 'status' | 'stage';
export interface Column { key: string; label: string; type?: ColType }
export interface Section { title: string; columns: Column[]; rows: Record<string, unknown>[] }
export interface Report { key: string; title: string; description: string; date_basis: string; sections: Section[] }

export const REPORTS: { key: string; title: string; description: string }[] = [
  { key: 'property', title: 'Property-wise', description: 'Volume, backlog, delay and turnaround by property' },
  { key: 'category', title: 'Category-wise', description: 'Volume, backlog, delay and turnaround by work category' },
  { key: 'engineer', title: 'Engineer-wise', description: 'Assigned workload, completion and on-time rate by engineer' },
  { key: 'stage', title: 'Stage-wise', description: 'Completion, SLA compliance and delay for each workflow stage' },
  { key: 'pending', title: 'Pending Work', description: 'All open job cards with their current stage and overdue time' },
  { key: 'completed', title: 'Completed Work', description: 'Job cards whose work was completed in the period, with TAT' },
  { key: 'delayed', title: 'Delayed Work', description: 'Job cards currently overdue or completed after the planned date' },
  { key: 'tat', title: 'TAT / SLA', description: 'Turnaround distribution and SLA compliance' },
  { key: 'historical', title: 'Historical FMS', description: 'Imported FMS records in the original sheet layout' },
];

const LIVE = `r.status IN ('open','in_progress','pending_action','pending_approval','completed')`;
const TAT_HOURS = `CASE WHEN wc.status = 'completed' AND wc.actual_at >= r.requested_at THEN (julianday(wc.actual_at) - julianday(r.requested_at)) * 24 END`;

const round = (v: unknown, dp = 1) => (v === null || v === undefined ? null : Math.round(Number(v) * 10 ** dp) / 10 ** dp);

function groupSection(title: string, labelHeader: string, join: string, idCol: string, nameCol: string, where: string, params: Record<string, any>): Section {
  const rows = all(
    `SELECT ${idCol} AS id, COALESCE(${nameCol}, 'Unassigned') AS name, COUNT(*) AS total,
       SUM(${LIVE}) AS active, SUM(r.status = 'on_hold') AS on_hold, SUM(r.status = 'closed') AS closed, SUM(r.status = 'cancelled') AS cancelled,
       SUM(${OVERDUE_SQL}) AS overdue,
       SUM(wc.status = 'completed') AS work_done,
       SUM(wc.status = 'completed' AND wc.delay_minutes <= 0) AS on_time,
       SUM(wc.status = 'completed' AND wc.delay_minutes > 0) AS late,
       AVG(${TAT_HOURS}) AS avg_tat
     FROM requests r ${join}
     LEFT JOIN request_stages wc ON wc.request_id = r.id AND wc.stage_key = 'work_completed'
     WHERE ${where} GROUP BY ${idCol} ORDER BY total DESC`,
    params,
  ).map((r) => {
    const measured = Number(r.on_time ?? 0) + Number(r.late ?? 0);
    return { ...r, on_time_pct: measured ? round((Number(r.on_time) / measured) * 100) : null, avg_tat: round(r.avg_tat) };
  });
  return {
    title,
    columns: [
      { key: 'name', label: labelHeader }, { key: 'total', label: 'Total', type: 'number' }, { key: 'active', label: 'Open', type: 'number' },
      { key: 'overdue', label: 'Overdue', type: 'number' }, { key: 'on_hold', label: 'On Hold', type: 'number' },
      { key: 'closed', label: 'Closed', type: 'number' }, { key: 'work_done', label: 'Work Done', type: 'number' },
      { key: 'on_time_pct', label: 'On-time %', type: 'percent' }, { key: 'avg_tat', label: 'Avg TAT (h)', type: 'hours' },
    ],
    rows,
  };
}

function stageSection(where: string, params: Record<string, any>): Section {
  const stats = new Map(
    all(
      `SELECT s.stage_key AS k,
         SUM(s.status <> 'skipped') AS applicable, SUM(s.status = 'completed') AS completed, SUM(s.status = 'skipped') AS skipped,
         SUM(s.status IN ('active','rejected') AND ${LIVE}) AS in_stage,
         SUM(s.status = 'active' AND ${LIVE} AND s.planned_at < :now) AS overdue_now,
         SUM(s.status = 'completed' AND s.delay_minutes IS NOT NULL AND s.delay_minutes <= 0) AS on_time,
         SUM(s.status = 'completed' AND s.delay_minutes > 0) AS late,
         AVG(CASE WHEN s.status = 'completed' AND s.delay_minutes > 0 THEN s.delay_minutes END) / 60.0 AS avg_delay
       FROM request_stages s JOIN requests r ON r.id = s.request_id WHERE ${where} GROUP BY s.stage_key`,
      params,
    ).map((r) => [r.k, r]),
  );
  const rows = stageDefs().filter((d) => d.key !== 'created').map((d) => {
    const s = stats.get(d.key) ?? {};
    const measured = Number(s.on_time ?? 0) + Number(s.late ?? 0);
    return {
      stage: d.name, sla: d.sla.type === 'none' ? '—' : undefined, applicable: s.applicable ?? 0, completed: s.completed ?? 0, skipped: s.skipped ?? 0,
      in_stage: s.in_stage ?? 0, overdue_now: s.overdue_now ?? 0, on_time: s.on_time ?? 0, late: s.late ?? 0,
      sla_pct: measured ? round((Number(s.on_time) / measured) * 100) : null, avg_delay: round(s.avg_delay),
    };
  });
  return {
    title: 'Stage performance',
    columns: [
      { key: 'stage', label: 'Stage' }, { key: 'applicable', label: 'Applicable', type: 'number' }, { key: 'completed', label: 'Completed', type: 'number' },
      { key: 'skipped', label: 'Skipped', type: 'number' }, { key: 'in_stage', label: 'Currently here', type: 'number' },
      { key: 'overdue_now', label: 'Overdue now', type: 'number' }, { key: 'on_time', label: 'On time', type: 'number' },
      { key: 'late', label: 'Late', type: 'number' }, { key: 'sla_pct', label: 'SLA met %', type: 'percent' },
      { key: 'avg_delay', label: 'Avg delay when late (h)', type: 'hours' },
    ],
    rows,
  };
}

const LIST_COLUMNS: Column[] = [
  { key: 'request_no', label: 'Job Card', type: 'request' }, { key: 'requested_at', label: 'Raised', type: 'datetime' },
  { key: 'property_name', label: 'Property' }, { key: 'category_name', label: 'Category' }, { key: 'title', label: 'Description' },
  { key: 'engineer_name', label: 'Engineer' },
];

const LIST_FROM = `FROM requests r
  JOIN properties p ON p.id = r.property_id JOIN work_categories c ON c.id = r.category_id
  LEFT JOIN engineers e ON e.id = COALESCE(r.assigned_engineer_id, r.site_engineer_id)
  LEFT JOIN request_stages wc ON wc.request_id = r.id AND wc.stage_key = 'work_completed'`;

export function runReport(key: string, query: Record<string, any>, user: AuthUser): Report {
  const meta = REPORTS.find((r) => r.key === key);
  if (!meta) throw notFound('Report');
  const now = nowLocal();
  const dateBasis = key === 'completed' ? 'Work completion date' : 'Request date';
  const filterQuery = key === 'completed' ? { ...query, from: undefined, to: undefined, closed_from: query.from, closed_to: query.to } : query;
  const { where, params } = buildFilter(filterQuery, user);
  const sections: Section[] = [];

  switch (key) {
    case 'property':
      sections.push(groupSection('By property', 'Property', 'JOIN properties p ON p.id = r.property_id', 'p.id', 'p.name', where, params));
      break;
    case 'category':
      sections.push(groupSection('By work category', 'Category', 'JOIN work_categories c ON c.id = r.category_id', 'c.id', 'c.name', where, params));
      break;
    case 'engineer':
      sections.push(groupSection('By assigned engineer', 'Engineer', 'LEFT JOIN engineers e ON e.id = COALESCE(r.assigned_engineer_id, r.site_engineer_id)', 'e.id', 'e.name', where, params));
      break;
    case 'stage':
      sections.push(stageSection(where, params));
      break;
    case 'pending': {
      const rows = all(`SELECT r.*, p.name AS property_name, c.name AS category_name, e.name AS engineer_name ${LIST_FROM}
        WHERE ${where} AND ${LIVE} ORDER BY r.current_stage_planned_at ASC`, params).map((r) => ({
        ...r,
        stage: stageName(r.current_stage_key),
        age_days: round((diffMinutes(now, r.requested_at) ?? 0) / 1440),
        overdue_hours: r.current_stage_planned_at && r.current_stage_planned_at < now ? round((diffMinutes(now, r.current_stage_planned_at) ?? 0) / 60) : null,
      }));
      sections.push({
        title: `Pending (${rows.length})`,
        columns: [...LIST_COLUMNS, { key: 'status', label: 'Status', type: 'status' }, { key: 'stage', label: 'Current stage' },
          { key: 'current_stage_planned_at', label: 'Stage due', type: 'datetime' }, { key: 'overdue_hours', label: 'Overdue (h)', type: 'hours' },
          { key: 'age_days', label: 'Age (days)', type: 'number' }],
        rows,
      });
      break;
    }
    case 'completed': {
      const rows = all(`SELECT r.*, p.name AS property_name, c.name AS category_name, e.name AS engineer_name, wc.planned_at AS wc_planned,
          wc.actual_at AS wc_actual, wc.delay_minutes AS wc_delay, ${TAT_HOURS} AS tat
        ${LIST_FROM} WHERE ${where} AND wc.status = 'completed' ORDER BY wc.actual_at DESC`, params).map((r) => ({
        ...r, tat: round(r.tat), delay_hours: r.wc_delay > 0 ? round(r.wc_delay / 60) : 0,
      }));
      sections.push({
        title: `Completed (${rows.length})`,
        columns: [...LIST_COLUMNS, { key: 'wc_planned', label: 'Planned completion', type: 'datetime' }, { key: 'wc_actual', label: 'Completed', type: 'datetime' },
          { key: 'delay_hours', label: 'Delay (h)', type: 'hours' }, { key: 'tat', label: 'TAT (h)', type: 'hours' }, { key: 'status', label: 'Status', type: 'status' },
          { key: 'closure_category', label: 'Closure' }],
        rows,
      });
      break;
    }
    case 'delayed': {
      const rows = all(`SELECT r.*, p.name AS property_name, c.name AS category_name, e.name AS engineer_name, wc.planned_at AS wc_planned,
          wc.actual_at AS wc_actual, wc.delay_minutes AS wc_delay, CASE WHEN ${OVERDUE_SQL} THEN 1 ELSE 0 END AS overdue_now
        ${LIST_FROM} WHERE ${where} AND (${OVERDUE_SQL} OR (wc.status = 'completed' AND wc.delay_minutes > 0))
        ORDER BY overdue_now DESC, r.requested_at DESC`, params).map((r) => ({
        ...r,
        kind: r.overdue_now ? `Overdue at ${stageName(r.current_stage_key)}` : 'Completed late',
        delay_hours: r.overdue_now ? round((diffMinutes(now, r.current_stage_planned_at) ?? 0) / 60) : round(r.wc_delay / 60),
      }));
      sections.push({
        title: `Delayed (${rows.length})`,
        columns: [...LIST_COLUMNS, { key: 'kind', label: 'Delay type' }, { key: 'wc_planned', label: 'Planned completion', type: 'datetime' },
          { key: 'wc_actual', label: 'Completed', type: 'datetime' }, { key: 'delay_hours', label: 'Delay (h)', type: 'hours' }, { key: 'status', label: 'Status', type: 'status' }],
        rows,
      });
      break;
    }
    case 'tat': {
      const buckets = all(`SELECT
          CASE WHEN t < 24 THEN '1. Within 1 day' WHEN t < 72 THEN '2. 1–3 days' WHEN t < 168 THEN '3. 3–7 days'
               WHEN t < 360 THEN '4. 7–15 days' WHEN t < 720 THEN '5. 15–30 days' ELSE '6. Over 30 days' END AS bucket,
          COUNT(*) AS n
        FROM (SELECT ${TAT_HOURS} AS t FROM requests r LEFT JOIN request_stages wc ON wc.request_id = r.id AND wc.stage_key = 'work_completed' WHERE ${where})
        WHERE t IS NOT NULL GROUP BY bucket ORDER BY bucket`, params);
      const totalDone = buckets.reduce((a, b) => a + Number(b.n), 0);
      sections.push({
        title: 'Turnaround time (raised → work completed)',
        columns: [{ key: 'bucket', label: 'TAT band' }, { key: 'n', label: 'Job cards', type: 'number' }, { key: 'pct', label: 'Share %', type: 'percent' }],
        rows: buckets.map((b) => ({ bucket: String(b.bucket).slice(3), n: b.n, pct: totalDone ? round((Number(b.n) / totalDone) * 100) : null })),
      });
      const byCat = groupSection('TAT by category', 'Category', 'JOIN work_categories c ON c.id = r.category_id', 'c.id', 'c.name', where, params);
      byCat.columns = byCat.columns.filter((c) => ['name', 'work_done', 'on_time_pct', 'avg_tat'].includes(c.key));
      byCat.rows = byCat.rows.filter((r) => Number(r.work_done) > 0);
      sections.push(stageSection(where, params), byCat);
      sections[1].title = 'SLA compliance by stage';
      break;
    }
    case 'historical': {
      const reqs = all(`SELECT r.id, r.request_no, r.requested_at, r.target_date, r.description, r.status, r.closure_note, r.verified_by_name,
          p.name AS property_name, c.name AS category_name, r.import_batch_id, r.import_row_no
        FROM requests r JOIN properties p ON p.id = r.property_id JOIN work_categories c ON c.id = r.category_id
        WHERE ${where} AND r.source = 'fms_import' ORDER BY r.requested_at`, params);
      const stageRows = all(`SELECT s.request_id, s.stage_key, s.planned_at, s.actual_at, s.status, s.delay_minutes, s.comments, e.name AS engineer_name
        FROM request_stages s JOIN requests r ON r.id = s.request_id LEFT JOIN engineers e ON e.id = s.engineer_id
        WHERE ${where} AND r.source = 'fms_import' AND s.stage_key IN (${[...LEGACY_STAGE_KEYS, 'verification'].map((k) => `'${k}'`).join(',')})`, params);
      const byReq = new Map<number, Record<string, any>>();
      for (const s of stageRows) {
        const o = byReq.get(s.request_id) ?? {};
        o[`${s.stage_key}_planned`] = s.planned_at;
        o[`${s.stage_key}_actual`] = s.actual_at;
        o[`${s.stage_key}_status`] = s.status;
        o[`${s.stage_key}_delay`] = s.delay_minutes !== null ? round(s.delay_minutes / 60) : null;
        if (s.engineer_name) o[`${s.stage_key}_engineer`] = s.engineer_name;
        if (s.stage_key === 'verification') o.remarks = s.comments;
        byReq.set(s.request_id, o);
      }
      const columns: Column[] = [
        { key: 'request_no', label: 'Job Card', type: 'request' }, { key: 'import_row_no', label: 'Sheet row', type: 'number' },
        { key: 'requested_at', label: 'Timestamp', type: 'datetime' }, { key: 'property_name', label: 'Property' },
        { key: 'category_name', label: 'Work Category' }, { key: 'target_date', label: 'Work Completion Date', type: 'date' },
        { key: 'description', label: 'Narration' },
      ];
      for (const k of LEGACY_STAGE_KEYS) {
        const n = stageName(k);
        columns.push(
          { key: `${k}_planned`, label: `${n} – Planned`, type: 'datetime' }, { key: `${k}_actual`, label: `${n} – Actual`, type: 'datetime' },
          { key: `${k}_status`, label: `${n} – Status` }, { key: `${k}_delay`, label: `${n} – Delay (h)`, type: 'hours' },
        );
        if (['site_visit', 'ph_discussion', 'work_completed'].includes(k)) columns.push({ key: `${k}_engineer`, label: `${n} – Engg` });
      }
      columns.push({ key: 'remarks', label: 'Remarks' }, { key: 'closure_note', label: 'Category By PC' }, { key: 'status', label: 'Current status', type: 'status' });
      sections.push({ title: `Historical FMS records (${reqs.length})`, columns, rows: reqs.map((r) => ({ ...r, ...(byReq.get(r.id) ?? {}) })) });
      break;
    }
  }
  return { ...meta, date_basis: dateBasis, sections };
}
