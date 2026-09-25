import type { AuthUser } from '../auth/auth.ts';
import { col, type Doc } from '../db/mongo.ts';
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
  { key: 'open_aging', title: 'Open Job Aging', description: 'How long every currently-open Job Card has been open' },
  { key: 'overdue', title: 'Overdue Jobs', description: 'Open jobs whose next action is past due' },
  { key: 'project_performance', title: 'Project Performance', description: 'Closed jobs, average resolution time and reopen count per project' },
  { key: 'delay_responsibility', title: 'Delay Responsibility', description: 'Which party (engineer, approval, material, vendor, management) owns each job’s largest delay' },
  { key: 'reopened', title: 'Reopened Jobs', description: 'Jobs that were closed and later reopened, with the latest reopen reason' },
];

function ddmmyyyyHms(v: string | null | undefined): string {
  if (!v) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(v);
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}:${m[6]}` : v;
}

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

export const PROJECTION = {
  request_no: 1, requested_at: 1, title: 1, description: 1, status: 1, property_id: 1, category_id: 1, assigned_engineer_id: 1,
  site_engineer_id: 1, current_stage_key: 1, current_stage_planned_at: 1, closure_category: 1, closure_note: 1, target_date: 1,
  source: 1, import_row_no: 1, completed_at: 1, stages: 1, hold_reason: 1,
};

export async function runReport(key: string, query: Record<string, any>, user: AuthUser): Promise<Report> {
  const meta = REPORTS.find((r) => r.key === key);
  if (!meta) throw notFound('Report');
  const dateBasis = 'Request date';
  const { filter } = buildFilter(query, user);
  const now = nowLocal();
  const [rows, names] = await Promise.all([col.requests().find(filter, { projection: PROJECTION }).sort({ requested_at: 1 }).toArray(), masterNames()]);
  const sections: Section[] = [];

  switch (key) {
    case 'open_aging': {
      const section = await legacyPendingSection(rows, names, now);
      sections.push(section);
      break;
    }
    case 'overdue': {
      const out = rows.filter((r) => isOverdue(r, now))
        .map((r) => ({
          ...listBase(r, names), stage: stageName(r.current_stage_key),
          overdue_hours: round((diffMinutes(now, r.current_stage_planned_at) ?? 0) / 60),
        }))
        .sort((a, b) => (b.overdue_hours ?? 0) - (a.overdue_hours ?? 0));
      sections.push({
        title: `Overdue Jobs (${out.length})`,
        columns: [...LIST_COLUMNS, { key: 'status', label: 'Status', type: 'status' }, { key: 'stage', label: 'Current stage' },
          { key: 'current_stage_planned_at', label: 'Due', type: 'datetime' }, { key: 'overdue_hours', label: 'Overdue (h)', type: 'hours' }],
        rows: out,
      });
      break;
    }
    case 'project_performance': {
      const reopened = await reopenedIds();
      const closedRows = rows.filter((r) => r.status === 'closed');
      const groups = new Map<number | null, Doc[]>();
      for (const r of closedRows) groups.set(r.property_id ?? null, [...(groups.get(r.property_id ?? null) ?? []), r]);
      const out = [...groups.entries()].map(([id, list]) => {
        const re = list.reduce((n, r) => n + (reopened.has(r._id) ? 1 : 0), 0);
        return {
          id, name: id === null ? 'Unassigned' : names.properties.get(id) ?? `#${id}`, closed: list.length,
          avg_resolution_h: round(avg(list.map(tatHours).filter((x): x is number => x !== null))),
          reopened: re, reopen_pct: pct(re, list.length),
        };
      }).sort((a, b) => b.closed - a.closed);
      sections.push({
        title: 'Project performance',
        columns: [
          { key: 'name', label: 'Project' }, { key: 'closed', label: 'Closed', type: 'number' },
          { key: 'avg_resolution_h', label: 'Avg resolution (h)', type: 'hours' }, { key: 'reopened', label: 'Reopened', type: 'number' },
          { key: 'reopen_pct', label: 'Reopen %', type: 'percent' },
        ],
        rows: out,
      });
      break;
    }
    case 'delay_responsibility': {
      const defs = new Map<string, ReturnType<typeof stageDefs>[number]>(stageDefs().map((d) => [d.key, d]));
      const out = rows.map((r) => {
        const candidates = (r.stages as (StageRow & { responsible_role?: string | null })[])
          .map((s) => {
            const live = LIVE_STATUSES.includes(r.status);
            if (s.status === 'active' && live && s.planned_at && s.planned_at < now) return { key: s.stage_key, delay: diffMinutes(now, s.planned_at) ?? 0 };
            if (s.status === 'completed' && (s.delay_minutes ?? 0) > 0) return { key: s.stage_key, delay: s.delay_minutes! };
            return null;
          })
          .filter((x): x is { key: string; delay: number } => !!x)
          .sort((a, b) => b.delay - a.delay);
        const worst = candidates[0];
        if (!worst) return null;
        const def = defs.get(worst.key);
        const owner = worst.key === 'site_visit' ? names.engineers.get(r.site_engineer_id) ?? def?.responsibleLabel
          : ['work_started', 'work_completed'].includes(worst.key) ? names.engineers.get(r.assigned_engineer_id) ?? def?.responsibleLabel
            : def?.responsibleLabel ?? 'Unassigned';
        return { ...listBase(r, names), stage: stageName(worst.key), owner, delay_hours: round(worst.delay / 60) };
      }).filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => (b.delay_hours ?? 0) - (a.delay_hours ?? 0));
      sections.push({
        title: `Delay responsibility (${out.length})`,
        columns: [...LIST_COLUMNS, { key: 'status', label: 'Status', type: 'status' }, { key: 'stage', label: 'Stage with largest delay' },
          { key: 'owner', label: 'Responsible party' }, { key: 'delay_hours', label: 'Delay (h)', type: 'hours' }],
        rows: out,
      });
      break;
    }
    case 'reopened': {
      const ids = rows.map((r) => r._id);
      const events = await col.events().find({ request_id: { $in: ids }, type: 'reopen' }, { projection: { request_id: 1, message: 1, created_at: 1 } }).sort({ created_at: -1 }).toArray();
      const latest = new Map<number, { message: string; created_at: string }>();
      for (const e of events) if (!latest.has(e.request_id)) latest.set(e.request_id, { message: e.message, created_at: e.created_at });
      const out = rows.filter((r) => latest.has(r._id)).map((r) => {
        const ev = latest.get(r._id)!;
        return { ...listBase(r, names), reopened_at: ev.created_at, reopen_reason: ev.message };
      }).sort((a, b) => String(b.reopened_at).localeCompare(String(a.reopened_at)));
      sections.push({
        title: `Reopened jobs (${out.length})`,
        columns: [...LIST_COLUMNS, { key: 'status', label: 'Status', type: 'status' }, { key: 'reopened_at', label: 'Reopened at', type: 'datetime' }, { key: 'reopen_reason', label: 'Reopen reason' }],
        rows: out,
      });
      break;
    }
  }
  return { ...meta, date_basis: dateBasis, sections };
}

/** Job cards reopened for rework after being closed/completed (shared with the dashboard). */
async function reopenedIds(): Promise<Set<number>> {
  const ids = await col.events().distinct('request_id', { type: 'reopen', message: { $regex: '^Reopened' } });
  return new Set(ids as number[]);
}

export const LEGACY_PENDING_COLUMNS: Column[] = [
  { key: 'row_no', label: 'Row No.', type: 'number' }, { key: 'time', label: 'Time' }, { key: 'site', label: 'Site' },
  { key: 'work_category', label: 'Work Category' }, { key: 'image_1', label: 'Image of Location 1' }, { key: 'image_2', label: 'Image of Location 2' },
  { key: 'narration', label: 'Narration' }, { key: 'sheet_row_no', label: 'Row No.', type: 'number' }, { key: 'remark', label: 'Remark' },
];

/** Open job cards in the original FMS sheet column layout — used by the Open Job Aging report and the Job Cards "Open" CSV export. */
export async function legacyPendingSection(rows: Doc[], names: Names, now: string): Promise<Section> {
  const open = rows.filter((r) => LIVE_STATUSES.includes(r.status)).sort((a, b) => String(a.requested_at).localeCompare(String(b.requested_at)));
  const atts = await col.attachments().find(
    { request_id: { $in: open.map((r) => r._id) }, stage_key: 'created' },
    { projection: { request_id: 1, url: 1, file_name: 1, created_at: 1 } },
  ).sort({ created_at: 1 }).toArray();
  const imagesByRequest = new Map<number, string[]>();
  for (const a of atts) {
    const list = imagesByRequest.get(a.request_id) ?? [];
    list.push(a.url ?? `[uploaded file: ${a.file_name ?? a._id}]`);
    imagesByRequest.set(a.request_id, list);
  }
  const out = open.map((r, i) => {
    const imgs = imagesByRequest.get(r._id) ?? [];
    const remark = stage(r, 'verification')?.comments || r.closure_note || r.hold_reason || null;
    return {
      id: r._id, row_no: i + 1, time: ddmmyyyyHms(r.requested_at), site: names.properties.get(r.property_id) ?? '',
      work_category: names.categories.get(r.category_id) ?? '', image_1: imgs[0] ?? '', image_2: imgs[1] ?? '',
      narration: r.description ?? '', sheet_row_no: r.import_row_no ?? '', remark: remark ?? '',
    };
  });
  return { title: `Open Job Aging (${out.length})`, columns: LEGACY_PENDING_COLUMNS, rows: out };
}
