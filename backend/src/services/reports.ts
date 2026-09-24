import type { AuthUser } from '../auth/auth.ts';
import { col, type Doc } from '../db/mongo.ts';
import { LEGACY_STAGE_KEYS } from '../domain/workflow.ts';
import { diffMinutes, nowLocal, toMs } from '../utils/dates.ts';
import { notFound } from '../utils/http.ts';
import { masterNames } from './masters.ts';
import { buildFilter, isOverdue, LIVE_STATUSES } from './requests.ts';
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

const round = (v: number | null | undefined, dp = 1) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (a: number, b: number) => (b ? round((a / b) * 100) : null);

type StageRow = { stage_key: string; status: string; planned_at: string | null; actual_at: string | null; delay_minutes: number | null; engineer_id: number | null; comments: string | null };
const stage = (r: Doc, key: string): StageRow | undefined => (r.stages as StageRow[]).find((s) => s.stage_key === key);

/** Hours from raised to work completed (only when completed after being raised). */
function tatHours(r: Doc): number | null {
  const wc = stage(r, 'work_completed');
  if (wc?.status !== 'completed' || !wc.actual_at || wc.actual_at < r.requested_at) return null;
  return (toMs(wc.actual_at)! - toMs(r.requested_at)!) / 3600000;
}

type Names = Awaited<ReturnType<typeof masterNames>>;

function groupSection(title: string, labelHeader: string, rows: Doc[], keyOf: (r: Doc) => number | null, nameMap: Map<number, string>, now: string): Section {
  const groups = new Map<number | null, Doc[]>();
  for (const r of rows) groups.set(keyOf(r), [...(groups.get(keyOf(r)) ?? []), r]);
  const out = [...groups.entries()].map(([id, list]) => {
    const c = (fn: (r: Doc) => boolean) => list.reduce((n, r) => n + (fn(r) ? 1 : 0), 0);
    const done = (r: Doc) => stage(r, 'work_completed')?.status === 'completed';
    const onTime = c((r) => done(r) && (stage(r, 'work_completed')!.delay_minutes ?? 1) <= 0);
    const late = c((r) => done(r) && (stage(r, 'work_completed')!.delay_minutes ?? 0) > 0);
    return {
      id, name: id === null ? 'Unassigned' : nameMap.get(id) ?? `#${id}`, total: list.length,
      active: c((r) => LIVE_STATUSES.includes(r.status)), on_hold: c((r) => r.status === 'on_hold'), closed: c((r) => r.status === 'closed'),
      cancelled: c((r) => r.status === 'cancelled'), overdue: c((r) => isOverdue(r, now)), work_done: c(done),
      on_time: onTime, late, on_time_pct: pct(onTime, onTime + late),
      avg_tat: round(avg(list.map(tatHours).filter((x): x is number => x !== null))),
    };
  }).sort((a, b) => b.total - a.total);
  return {
    title,
    columns: [
      { key: 'name', label: labelHeader }, { key: 'total', label: 'Total', type: 'number' }, { key: 'active', label: 'Open', type: 'number' },
      { key: 'overdue', label: 'Overdue', type: 'number' }, { key: 'on_hold', label: 'On Hold', type: 'number' },
      { key: 'closed', label: 'Closed', type: 'number' }, { key: 'work_done', label: 'Work Done', type: 'number' },
      { key: 'on_time_pct', label: 'On-time %', type: 'percent' }, { key: 'avg_tat', label: 'Avg TAT (h)', type: 'hours' },
    ],
    rows: out,
  };
}

function stageSection(rows: Doc[], now: string): Section {
  const out = stageDefs().filter((d) => d.key !== 'created').map((d) => {
    let applicable = 0, completed = 0, skipped = 0, inStage = 0, overdueNow = 0, onTime = 0, late = 0;
    const delays: number[] = [];
    for (const r of rows) {
      const s = stage(r, d.key);
      if (!s) continue;
      const live = LIVE_STATUSES.includes(r.status);
      if (s.status !== 'skipped') applicable++; else skipped++;
      if (s.status === 'completed') {
        completed++;
        if (s.delay_minutes !== null && s.delay_minutes <= 0) onTime++;
        if ((s.delay_minutes ?? 0) > 0) { late++; delays.push(s.delay_minutes! / 60); }
      }
      if ((s.status === 'active' || s.status === 'rejected') && live) inStage++;
      if (s.status === 'active' && live && s.planned_at && s.planned_at < now) overdueNow++;
    }
    return {
      stage: d.name, applicable, completed, skipped, in_stage: inStage, overdue_now: overdueNow, on_time: onTime, late,
      sla_pct: pct(onTime, onTime + late), avg_delay: round(avg(delays)),
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
    rows: out,
  };
}

const LIST_COLUMNS: Column[] = [
  { key: 'request_no', label: 'Job Card', type: 'request' }, { key: 'requested_at', label: 'Raised', type: 'datetime' },
  { key: 'property_name', label: 'Property' }, { key: 'category_name', label: 'Category' }, { key: 'title', label: 'Description' },
  { key: 'engineer_name', label: 'Engineer' },
];

function listBase(r: Doc, names: Names) {
  return {
    id: r._id, request_no: r.request_no, requested_at: r.requested_at, title: r.title, status: r.status,
    property_name: names.properties.get(r.property_id) ?? '—', category_name: names.categories.get(r.category_id) ?? '—',
    engineer_name: names.engineers.get(r.assigned_engineer_id ?? r.site_engineer_id) ?? null,
    closure_category: r.closure_category ?? null, current_stage_planned_at: r.current_stage_planned_at ?? null,
  };
}

const PROJECTION = {
  request_no: 1, requested_at: 1, title: 1, description: 1, status: 1, property_id: 1, category_id: 1, assigned_engineer_id: 1,
  site_engineer_id: 1, current_stage_key: 1, current_stage_planned_at: 1, closure_category: 1, closure_note: 1, target_date: 1,
  source: 1, import_row_no: 1, completed_at: 1, stages: 1,
};

export async function runReport(key: string, query: Record<string, any>, user: AuthUser): Promise<Report> {
  const meta = REPORTS.find((r) => r.key === key);
  if (!meta) throw notFound('Report');
  const dateBasis = key === 'completed' ? 'Work completion date' : 'Request date';
  const filterQuery = key === 'completed' ? { ...query, from: undefined, to: undefined, closed_from: query.from, closed_to: query.to } : query;
  const { filter } = buildFilter(filterQuery, user);
  const now = nowLocal();
  const [rows, names] = await Promise.all([col.requests().find(filter, { projection: PROJECTION }).sort({ requested_at: 1 }).toArray(), masterNames()]);
  const sections: Section[] = [];

  switch (key) {
    case 'property':
      sections.push(groupSection('By property', 'Property', rows, (r) => r.property_id, names.properties, now));
      break;
    case 'category':
      sections.push(groupSection('By work category', 'Category', rows, (r) => r.category_id, names.categories, now));
      break;
    case 'engineer':
      sections.push(groupSection('By assigned engineer', 'Engineer', rows, (r) => r.assigned_engineer_id ?? r.site_engineer_id ?? null, names.engineers, now));
      break;
    case 'stage':
      sections.push(stageSection(rows, now));
      break;
    case 'pending': {
      const out = rows.filter((r) => LIVE_STATUSES.includes(r.status))
        .sort((a, b) => String(a.current_stage_planned_at ?? '9').localeCompare(String(b.current_stage_planned_at ?? '9')))
        .map((r) => ({
          ...listBase(r, names), stage: stageName(r.current_stage_key),
          age_days: round((diffMinutes(now, r.requested_at) ?? 0) / 1440),
          overdue_hours: r.current_stage_planned_at && r.current_stage_planned_at < now ? round((diffMinutes(now, r.current_stage_planned_at) ?? 0) / 60) : null,
        }));
      sections.push({
        title: `Pending (${out.length})`,
        columns: [...LIST_COLUMNS, { key: 'status', label: 'Status', type: 'status' }, { key: 'stage', label: 'Current stage' },
          { key: 'current_stage_planned_at', label: 'Stage due', type: 'datetime' }, { key: 'overdue_hours', label: 'Overdue (h)', type: 'hours' },
          { key: 'age_days', label: 'Age (days)', type: 'number' }],
        rows: out,
      });
      break;
    }
    case 'completed': {
      const out = rows.filter((r) => stage(r, 'work_completed')?.status === 'completed')
        .map((r) => {
          const wc = stage(r, 'work_completed')!;
          return { ...listBase(r, names), wc_planned: wc.planned_at, wc_actual: wc.actual_at, delay_hours: (wc.delay_minutes ?? 0) > 0 ? round(wc.delay_minutes! / 60) : 0, tat: round(tatHours(r)) };
        })
        .sort((a, b) => String(b.wc_actual).localeCompare(String(a.wc_actual)));
      sections.push({
        title: `Completed (${out.length})`,
        columns: [...LIST_COLUMNS, { key: 'wc_planned', label: 'Planned completion', type: 'datetime' }, { key: 'wc_actual', label: 'Completed', type: 'datetime' },
          { key: 'delay_hours', label: 'Delay (h)', type: 'hours' }, { key: 'tat', label: 'TAT (h)', type: 'hours' }, { key: 'status', label: 'Status', type: 'status' },
          { key: 'closure_category', label: 'Closure' }],
        rows: out,
      });
      break;
    }
    case 'delayed': {
      const out = rows.map((r) => {
        const wc = stage(r, 'work_completed');
        const overdueNow = isOverdue(r, now);
        const lateDone = wc?.status === 'completed' && (wc.delay_minutes ?? 0) > 0;
        if (!overdueNow && !lateDone) return null;
        return {
          ...listBase(r, names), wc_planned: wc?.planned_at ?? null, wc_actual: wc?.actual_at ?? null, overdue_now: overdueNow,
          kind: overdueNow ? `Overdue at ${stageName(r.current_stage_key)}` : 'Completed late',
          delay_hours: overdueNow ? round((diffMinutes(now, r.current_stage_planned_at) ?? 0) / 60) : round(wc!.delay_minutes! / 60),
        };
      }).filter((x): x is NonNullable<typeof x> => !!x)
        .sort((a, b) => Number(b.overdue_now) - Number(a.overdue_now) || String(b.requested_at).localeCompare(String(a.requested_at)));
      sections.push({
        title: `Delayed (${out.length})`,
        columns: [...LIST_COLUMNS, { key: 'kind', label: 'Delay type' }, { key: 'wc_planned', label: 'Planned completion', type: 'datetime' },
          { key: 'wc_actual', label: 'Completed', type: 'datetime' }, { key: 'delay_hours', label: 'Delay (h)', type: 'hours' }, { key: 'status', label: 'Status', type: 'status' }],
        rows: out,
      });
      break;
    }
    case 'tat': {
      const bands = ['Within 1 day', '1–3 days', '3–7 days', '7–15 days', '15–30 days', 'Over 30 days'];
      const band = (t: number) => (t < 24 ? 0 : t < 72 ? 1 : t < 168 ? 2 : t < 360 ? 3 : t < 720 ? 4 : 5);
      const counts = new Array(bands.length).fill(0);
      const tats = rows.map(tatHours).filter((x): x is number => x !== null);
      for (const t of tats) counts[band(t)]++;
      sections.push({
        title: 'Turnaround time (raised → work completed)',
        columns: [{ key: 'bucket', label: 'TAT band' }, { key: 'n', label: 'Job cards', type: 'number' }, { key: 'pct', label: 'Share %', type: 'percent' }],
        rows: bands.map((b, i) => ({ bucket: b, n: counts[i], pct: pct(counts[i], tats.length) })).filter((r) => r.n > 0),
      });
      const sla = stageSection(rows, now);
      sla.title = 'SLA compliance by stage';
      const byCat = groupSection('TAT by category', 'Category', rows, (r) => r.category_id, names.categories, now);
      byCat.columns = byCat.columns.filter((c) => ['name', 'work_done', 'on_time_pct', 'avg_tat'].includes(c.key));
      byCat.rows = byCat.rows.filter((r) => Number(r.work_done) > 0);
      sections.push(sla, byCat);
      break;
    }
    case 'historical': {
      const out = rows.filter((r) => r.source === 'fms_import').map((r) => {
        const o: Record<string, unknown> = {
          id: r._id, request_no: r.request_no, import_row_no: r.import_row_no, requested_at: r.requested_at, target_date: r.target_date,
          description: r.description, status: r.status, closure_note: r.closure_note,
          property_name: names.properties.get(r.property_id) ?? '—', category_name: names.categories.get(r.category_id) ?? '—',
        };
        for (const k of [...LEGACY_STAGE_KEYS, 'verification']) {
          const s = stage(r, k);
          if (!s) continue;
          Object.assign(o, {
            [`${k}_planned`]: s.planned_at, [`${k}_actual`]: s.actual_at, [`${k}_status`]: s.status,
            [`${k}_delay`]: s.delay_minutes !== null ? round(s.delay_minutes / 60) : null,
          });
          if (s.engineer_id) o[`${k}_engineer`] = names.engineers.get(s.engineer_id) ?? null;
          if (k === 'verification') o.remarks = s.comments;
        }
        return o;
      });
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
      sections.push({ title: `Historical FMS records (${out.length})`, columns, rows: out });
      break;
    }
  }
  return { ...meta, date_basis: dateBasis, sections };
}
