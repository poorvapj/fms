import { createHash } from 'node:crypto';
import {
  computePlanned, DEFAULT_STAGES, LEGACY_STAGE_KEYS, normalizeWorkType, PRIORITIES, type Priority, type StageKey, type StageStatus,
} from '../domain/workflow.ts';
import { diffMinutes, parseSheetDate } from '../utils/dates.ts';
import type { StageMeta } from './layout.ts';
import type { Mapping, StageField } from './mapping.ts';

export interface ImportOptions {
  /** Derive blank Planned dates from the SLA rules (flagged as inferred). */
  infer_planned: boolean;
  /** Create properties / categories / engineers that do not exist yet. */
  auto_create_masters: boolean;
  /** "skip" rows already imported, or "update" them if untouched in the app. */
  mode: 'skip' | 'update';
}

export const DEFAULT_OPTIONS: ImportOptions = { infer_planned: true, auto_create_masters: true, mode: 'skip' };

export interface Issue { row_no: number; severity: 'error' | 'warning'; field: string; message: string; value?: string }

export interface PlannedStage {
  key: StageKey;
  status: StageStatus;
  planned_at: string | null;
  actual_at: string | null;
  delay_minutes: number | null;
  planned_inferred: boolean;
  actual_inferred: boolean;
  engineer: string | null;
  responsible_name: string | null;
  comments: string | null;
  legacy: Partial<Record<StageField, string>> | null;
}

export interface PlannedRecord {
  row_no: number;               // 1-based sheet line
  legacy_key: string;
  requested_at: string;
  property: string;
  category: string;
  title: string;
  description: string | null;
  target_date: string | null;
  priority: Priority;
  requester_name: string | null;
  requester_email: string | null;
  work_type: string | null;
  property_no: string | null;
  reason: string | null;
  location_images: string[];
  completion_images: string[];
  closure_note: string | null;
  closure_category: string | null;
  verified_by_name: string | null;
  site_engineer: string | null;
  assigned_engineer: string | null;
  hold_reason: string | null;
  cancel_reason: string | null;
  stages: PlannedStage[];
  cells: string[];
}

const DONE = /^(y|yes|yee|yew|yas|ok|okay|done|complete|completed|true|1|✓|✔)$/i;
const NOT_DONE = /^(n|no|pending|not done|false|0)$/i;
const NON_ENGINEER = /^(hold|na|n\/a|-|\/|nil|none)$/i;

const clean = (v: string | undefined) => {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  return s === '#VALUE!' || s === '#N/A' || s === '#REF!' ? '' : s;
};

/** "kuldeep " → "Kuldeep", "mukesh baghel" → "Mukesh Baghel", "Other" → "Other (External)". */
export function normalizeEngineer(raw: string): string | null {
  const s = clean(raw);
  if (!s || NON_ENGINEER.test(s)) return null;
  if (/^others?$/i.test(s)) return 'Other (External)';
  return s.split(' ').map((w) => (w.length <= 2 && w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1).toLowerCase())).join(' ');
}

export function normalizeMasterName(raw: string): string {
  return clean(raw);
}

export function classifyClosure(note: string | null): string | null {
  if (!note) return null;
  const t = note.toLowerCase();
  if (/\bhold\b/.test(t)) return 'On Hold';
  if (/wrong/.test(t)) return 'Wrong Complaint';
  if (/service|repair/.test(t)) return 'Service / Repair Complaint';
  if (/done|close|complete/.test(t)) return 'Work Done';
  return null;
}

function urls(text: string): string[] {
  return (text.match(/https?:\/\/[^\s,;]+/gi) ?? []).map((u) => u.replace(/[)\].]+$/, ''));
}

export function legacyKey(requestedAt: string, property: string, category: string, narration: string): string {
  return createHash('sha1').update([requestedAt, property.toLowerCase(), category.toLowerCase(), narration.replace(/\s+/g, ' ').trim().toLowerCase()].join('|')).digest('hex');
}

/** Stage-specific sheet "Who" text, used as responsible name when no engineer is recorded. */
export function whoByStage(stages: StageMeta[]): Partial<Record<StageKey, string>> {
  const out: Partial<Record<StageKey, string>> = {};
  for (const s of stages) if (s.stage_key && s.who) out[s.stage_key] = s.who;
  return out;
}

export function transformRow(
  cells: string[],
  rowNo: number,
  mapping: Mapping,
  options: ImportOptions,
  who: Partial<Record<StageKey, string>>,
): { record: PlannedRecord | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const warn = (field: string, message: string, value?: string) => issues.push({ row_no: rowNo, severity: 'warning', field, message, value });
  const fail = (field: string, message: string, value?: string) => issues.push({ row_no: rowNo, severity: 'error', field, message, value });

  const req: Record<string, string> = {};
  const stageRaw: Partial<Record<StageKey, Partial<Record<StageField, string>>>> = {};
  for (const [col, target] of Object.entries(mapping)) {
    if (!target) continue;
    const value = clean(cells[Number(col)]);
    const rawValue = (cells[Number(col)] ?? '').trim();
    if (rawValue === '#VALUE!' || rawValue === '#N/A' || rawValue === '#REF!') warn(target, 'Spreadsheet error value ignored', rawValue);
    const parts = target.split('.');
    if (parts[0] === 'request') req[parts[1]] = value;
    else {
      const key = parts[1] as StageKey;
      (stageRaw[key] ??= {})[parts[2] as StageField] = value;
    }
  }

  const requestedAt = parseSheetDate(req.requested_at);
  if (!requestedAt) fail('Timestamp', req.requested_at ? 'Unreadable request timestamp' : 'Request timestamp is missing', req.requested_at);
  const property = normalizeMasterName(req.property ?? '');
  if (!property) fail('Property', 'Property is missing');
  const category = normalizeMasterName(req.category ?? '');
  if (!category) fail('Work Category', 'Work category is missing');
  if (issues.some((i) => i.severity === 'error')) return { record: null, issues };

  const description = req.description || null;
  const target = req.target_date ? parseSheetDate(req.target_date) : null;
  if (req.target_date && !target) warn('Work Completion Date', 'Unreadable date — kept in legacy data only', req.target_date);
  if (target && target.slice(0, 10) < requestedAt!.slice(0, 10)) warn('Work Completion Date', 'Target date is before the request date', req.target_date);
  let priority: Priority = 'medium';
  if (req.priority) {
    const p = req.priority.toLowerCase() as Priority;
    if (PRIORITIES.includes(p)) priority = p;
    else warn('Priority', 'Unknown priority, using medium', req.priority);
  }

  // ---- legacy stage evaluation ------------------------------------------------------------------------------
  type Eval = { key: StageKey; planned: string | null; actual: string | null; done: boolean; hasData: boolean; raw: Partial<Record<StageField, string>> };
  const evals: Eval[] = [];
  const mappedStageKeys = new Set(Object.keys(stageRaw) as StageKey[]);
  for (const def of DEFAULT_STAGES) {
    if (!mappedStageKeys.has(def.key)) continue;
    const raw = stageRaw[def.key]!;
    const planned = raw.planned ? parseSheetDate(raw.planned) : null;
    const actual = raw.actual ? parseSheetDate(raw.actual) : null;
    if (raw.planned && !planned) warn(`${def.name} Planned`, 'Unreadable date', raw.planned);
    if (raw.actual && !actual) warn(`${def.name} Actual`, 'Unreadable date', raw.actual);
    const status = raw.status ?? '';
    const statusDone = DONE.test(status);
    if (status && !statusDone && !NOT_DONE.test(status)) warn(`${def.name} Status`, 'Unrecognised status value', status);
    if (statusDone && status !== 'Yes' && status.toLowerCase() !== 'yes') warn(`${def.name} Status`, `Status "${status}" read as Yes`, status);
    if (statusDone && !actual) warn(`${def.name}`, 'Marked done but no Actual date recorded');
    if (actual && requestedAt && actual < requestedAt) warn(`${def.name} Actual`, 'Actual date is before the request timestamp', raw.actual);
    const hasData = Object.values(raw).some((v) => !!v);
    evals.push({ key: def.key, planned, actual, done: !!actual || statusDone, hasData, raw });
  }
  const lastDoneSeq = Math.max(0, ...evals.filter((e) => e.done).map((e) => DEFAULT_STAGES.find((d) => d.key === e.key)!.seq));
  const evalByKey = new Map(evals.map((e) => [e.key, e]));

  const wc = evalByKey.get('work_completed');
  const workDone = !!wc?.done;
  const remarks = req.remarks || null;
  const closureNote = req.closure_note || null;
  const closureCategory = classifyClosure(closureNote);
  const verifiedBy = remarks ? /confirm(?:ed)?\s+by\s+(.+)/i.exec(remarks)?.[1]?.trim() ?? null : null;

  const engineerOf = (k: StageKey) => {
    const raw = stageRaw[k]?.engineer;
    if (!raw) return null;
    const n = normalizeEngineer(raw);
    if (!n) warn(`${DEFAULT_STAGES.find((d) => d.key === k)!.name} Engg`, `"${raw}" is not an engineer name — kept as note`, raw);
    return n;
  };
  const siteEngineer = engineerOf('site_visit');
  const phEngineer = engineerOf('ph_discussion');
  const wcEngineer = engineerOf('work_completed');
  const assignedEngineer = wcEngineer ?? phEngineer ?? siteEngineer;
  const holdByEngineerCol = LEGACY_STAGE_KEYS.some((k) => /^hold$/i.test(clean(stageRaw[k]?.engineer)));

  let holdReason: string | null = null;
  let cancelReason: string | null = null;
  if (!workDone) {
    if (closureCategory === 'On Hold' || holdByEngineerCol) holdReason = `FMS: ${closureNote ?? 'Engineer column marked Hold'}`;
    else if (closureCategory === 'Wrong Complaint') cancelReason = `FMS: ${closureNote}`;
  }

  const stages: PlannedStage[] = [];
  let prevActual: string | null = requestedAt;
  let firstOpenSeen = false;
  for (const def of DEFAULT_STAGES) {
    const e = evalByKey.get(def.key);
    const base: PlannedStage = {
      key: def.key, status: 'pending', planned_at: null, actual_at: null, delay_minutes: null,
      planned_inferred: false, actual_inferred: false, engineer: null, responsible_name: null, comments: null,
      legacy: e ? Object.fromEntries(Object.entries(e.raw).filter(([, v]) => v)) : null,
    };
    if (base.legacy && !Object.keys(base.legacy).length) base.legacy = null;

    if (def.key === 'created') {
      Object.assign(base, { status: 'completed', planned_at: requestedAt, actual_at: requestedAt, delay_minutes: 0, responsible_name: req.requester_name || 'FMS Google Form' });
    } else if (e) {
      base.planned_at = e.planned;
      base.engineer = def.key === 'site_visit' ? siteEngineer : def.key === 'ph_discussion' ? phEngineer : def.key === 'work_completed' ? assignedEngineer : def.key === 'engineer_assigned' ? assignedEngineer : null;
      base.responsible_name = (def.key === 'site_visit' || def.key === 'ph_discussion') && base.engineer ? base.engineer : who[def.key] ?? null;
      if (!e.done && def.key === 'engineer_assigned') base.engineer = null;
      if (e.done) {
        base.status = 'completed';
        base.actual_at = e.actual;
      } else if (def.seq < lastDoneSeq) {
        base.status = 'skipped';
        base.comments = e.hasData ? 'Not recorded in FMS (later stages were completed)' : 'Not recorded in FMS';
      } else if (def.optional && !e.hasData && (workDone || def.key === 'material')) {
        // Open rows keep PH discussion / permission pending (the FMS norm); the coordinator can mark them not required.
        base.status = 'skipped';
        base.comments = 'Not required (no FMS entry)';
      }
      if (def.key === 'work_completed' && req.completion_images && !urls(req.completion_images).length) {
        base.comments = `FMS image link: ${req.completion_images}`;
      }
    } else if (def.key === 'triage') {
      Object.assign(base, { status: 'skipped', comments: 'Not tracked in legacy FMS' });
    } else if (def.key === 'work_started') {
      if (workDone || def.seq < lastDoneSeq) Object.assign(base, { status: 'skipped', comments: 'Not tracked in legacy FMS' });
      base.engineer = assignedEngineer;
    } else if (def.key === 'verification' && workDone) {
      Object.assign(base, {
        status: 'completed', actual_at: wc!.actual, actual_inferred: true, responsible_name: verifiedBy ?? who.work_completed ?? null,
        comments: remarks ?? 'Legacy record — no separate verification step in FMS',
      });
    } else if (def.key === 'verification' && remarks) {
      base.comments = remarks;
    } else if (def.key === 'closed' && workDone) {
      Object.assign(base, {
        status: 'completed', actual_at: wc!.actual, actual_inferred: true, responsible_name: who.work_completed ?? null,
        comments: closureNote ?? 'Closed on FMS work completion',
      });
    }

    // Planned date inference for completed stages and the next open stage.
    const needsPlanned = !base.planned_at && base.status !== 'skipped' && (base.status === 'completed' || !firstOpenSeen) && def.key !== 'created';
    if (needsPlanned && options.infer_planned && !base.actual_inferred) {
      const planned = computePlanned(def.sla, requestedAt, prevActual, false);
      if (planned) { base.planned_at = planned; base.planned_inferred = true; }
    }
    if (base.status === 'completed') {
      base.delay_minutes = base.actual_at && base.planned_at && !base.actual_inferred ? diffMinutes(base.actual_at, base.planned_at) : null;
      if (base.actual_at) prevActual = base.actual_at;
    } else if (base.status === 'pending') {
      firstOpenSeen = true;
    }
    stages.push(base);
  }
  if (!workDone && closureNote && !holdReason && !cancelReason) warn('Category By PC Mam', 'Closure note present but work is not completed', closureNote);

  const narration = description ?? '';
  const titleSource = req.title || narration;
  const title = titleSource ? titleSource.replace(/\s+/g, ' ').slice(0, 80) + (titleSource.length > 80 ? '…' : '') : `${category} work at ${property}`;
  return {
    issues,
    record: {
      row_no: rowNo,
      legacy_key: legacyKey(requestedAt!, property, category, narration),
      requested_at: requestedAt!,
      property, category, title, description, target_date: target ? target.slice(0, 10) : null, priority,
      requester_name: req.requester_name || null,
      requester_email: req.requester_email || null,
      work_type: normalizeWorkType(req.work_type),
      property_no: req.property_no || null,
      reason: req.reason || null,
      location_images: req.location_images ? urls(req.location_images) : [],
      completion_images: req.completion_images ? urls(req.completion_images) : [],
      closure_note: closureNote,
      closure_category: workDone ? (closureCategory === 'On Hold' ? 'Work Done' : closureCategory ?? 'Work Done') : null,
      verified_by_name: verifiedBy,
      site_engineer: siteEngineer,
      assigned_engineer: assignedEngineer,
      hold_reason: holdReason,
      cancel_reason: cancelReason,
      stages,
      cells,
    },
  };
}
