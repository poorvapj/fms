import type { Filter } from 'mongodb';
import type { AuthUser } from '../auth/auth.ts';
import { col, type Doc } from '../db/mongo.ts';
import type { Role } from '../domain/permissions.ts';
import type { StageKey } from '../domain/workflow.ts';
import { diffMinutes, formatMs, nowLocal, todayLocal, toMs } from '../utils/dates.ts';
import { buildFilter, findRows, isOverdue, LIVE_STATUSES, scopeFilter } from './requests.ts';
import { masterNames } from './masters.ts';
import { stageDefs, stageName } from './stageDefs.ts';

const WAITING_APPROVAL: StageKey[] = ['triage', 'ph_discussion', 'permission'];
const VERIFICATION: StageKey[] = ['verification', 'closed'];

/** Job cards reopened for rework after being closed/completed. */
async function reopenedIds(): Promise<Set<number>> {
  const ids = await col.events().distinct('request_id', { type: 'reopen', message: { $regex: '^Reopened' } });
  return new Set(ids as number[]);
}

export async function dashboard(query: Record<string, any>, user: AuthUser) {
  const { filter, now } = buildFilter(query, user);
  const today = todayLocal();
  const since30 = formatMs(toMs(now)! - 30 * 86400000);
  const [rows, reopened, names] = await Promise.all([
    col.requests().find(filter, { projection: { status: 1, current_stage_key: 1, current_stage_planned_at: 1, closed_at: 1, property_id: 1, category_id: 1, assigned_engineer_id: 1, site_engineer_id: 1 } }).toArray(),
    reopenedIds(),
    masterNames(),
  ]);
  const live = (r: Doc) => LIVE_STATUSES.includes(r.status);
  const open = (r: Doc) => r.status !== 'closed' && r.status !== 'cancelled';
  const dueToday = (r: Doc) => live(r) && r.current_stage_planned_at?.slice(0, 10) === today && r.current_stage_planned_at >= now;
  const count = (fn: (r: Doc) => boolean) => rows.reduce((n, r) => n + (fn(r) ? 1 : 0), 0);

  const kpi = {
    total: rows.length,
    open_jobs: count(open),
    due_today: count(dueToday),
    overdue: count((r) => isOverdue(r, now)),
    waiting_material: count((r) => live(r) && r.current_stage_key === 'material'),
    waiting_approval: count((r) => live(r) && WAITING_APPROVAL.includes(r.current_stage_key)),
    in_progress: count((r) => r.status === 'in_progress'),
    verification_pending: count((r) => live(r) && VERIFICATION.includes(r.current_stage_key)),
    closed_30d: count((r) => r.status === 'closed' && (r.closed_at ?? '') >= since30),
    closed: count((r) => r.status === 'closed'),
    on_hold: count((r) => r.status === 'on_hold'),
    reopened: count((r) => reopened.has(r._id)),
  };

  const liveRows = rows.filter(live);
  const bottlenecks = stageDefs()
    .filter((d) => d.key !== 'created')
    .map((d) => ({ stage: d.name, count: liveRows.reduce((n, r) => n + (r.current_stage_key === d.key ? 1 : 0), 0) }))
    .filter((b) => b.count > 0)
    .sort((a, b) => b.count - a.count);

  const groupBy = ['property', 'category', 'engineer'].includes(query.group_by) ? query.group_by : 'property';
  const keyOf = (r: Doc): number | null => (groupBy === 'property' ? r.property_id : groupBy === 'category' ? r.category_id : r.assigned_engineer_id ?? r.site_engineer_id ?? null);
  const nameMap = groupBy === 'property' ? names.properties : groupBy === 'category' ? names.categories : names.engineers;
  const groups = new Map<number | null, Doc[]>();
  for (const r of rows) {
    const k = keyOf(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const health = [...groups.entries()].map(([id, list]) => {
    const c = (fn: (r: Doc) => boolean) => list.reduce((n, r) => n + (fn(r) ? 1 : 0), 0);
    const closed = c((r) => r.status === 'closed');
    const re = c((r) => reopened.has(r._id));
    return {
      id, name: id === null ? 'Unassigned' : nameMap.get(id) ?? `#${id}`,
      open: c(open), overdue: c((r) => isOverdue(r, now)), due_today: c(dueToday),
      waiting_material: c((r) => live(r) && r.current_stage_key === 'material'),
      waiting_approval: c((r) => live(r) && WAITING_APPROVAL.includes(r.current_stage_key)),
      closed, reopened: re, total: list.length, reopen_rate: closed ? Math.round((re / closed) * 1000) / 10 : 0,
    };
  }).sort((a, b) => b.open - a.open || b.overdue - a.overdue || a.name.localeCompare(b.name));

  return { kpi, health, group_by: groupBy, bottlenecks };
}

/** Stages each non-engineer role is primarily responsible for (their "My Jobs" queue). */
const ROLE_QUEUE: Partial<Record<Role, StageKey[]>> = {
  admin: ['triage', 'communicate_requester', 'engineer_assigned', 'verification', 'closed'],
  coordinator: ['triage', 'communicate_requester', 'engineer_assigned', 'verification', 'closed'],
  project_head: ['ph_discussion', 'verification'],
  approver: ['permission'],
  store: ['material'],
};

/** My Jobs board: Overdue / Today / Blocked / Upcoming for the signed-in user. */
export async function myJobs(_query: Record<string, any>, user: AuthUser) {
  const now = nowLocal();
  const eng = user.engineer_id ?? -1;
  let actionable: Filter<Doc>;
  let involved: Filter<Doc>;
  if (user.role === 'engineer') {
    actionable = { $or: [{ current_stage_key: 'site_visit', site_engineer_id: eng }, { current_stage_key: { $in: ['work_started', 'work_completed'] }, assigned_engineer_id: eng }] };
    involved = { $or: [{ assigned_engineer_id: eng }, { site_engineer_id: eng }] };
  } else {
    const keys = ROLE_QUEUE[user.role] ?? [];
    actionable = { current_stage_key: { $in: keys } };
    involved = actionable;
  }
  const mine = await findRows({ $and: [{ status: { $in: LIVE_STATUSES } }, actionable] }, { current_stage_planned_at: 1 });
  mine.sort((a, b) => (a.current_stage_planned_at === null ? 1 : 0) - (b.current_stage_planned_at === null ? 1 : 0));
  const blocked = await findRows({ $and: [involved, { $nor: [actionable] }, { status: { $in: ['on_hold', 'pending_approval'] } }] }, { requested_at: -1 }, 200);
  const today = now.slice(0, 10);
  return {
    overdue: mine.filter((r) => r.is_overdue),
    today: mine.filter((r) => !r.is_overdue && r.current_stage_planned_at?.slice(0, 10) === today),
    blocked,
    upcoming: mine.filter((r) => !r.is_overdue && r.current_stage_planned_at?.slice(0, 10) !== today),
  };
}

export interface QueueItem {
  id: number;
  job_no: string;
  kind: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  what: string;
  why: string;
  owner: string;
  late_minutes: number | null;
  action: string;
}

/**
 * Process Coordinator exception queue: every open job card that needs a coordinator decision or chasing,
 * with what happened, why it was flagged, who owns it and what to do next.
 */
export async function coordinatorQueue(query: Record<string, any>, user: AuthUser) {
  const now = nowLocal();
  const [rows, names] = await Promise.all([
    col.requests().find(
      { $and: [scopeFilter(user), { status: { $in: [...LIVE_STATUSES, 'on_hold'] } }] },
      { projection: { request_no: 1, status: 1, current_stage_key: 1, current_stage_planned_at: 1, site_engineer_id: 1, assigned_engineer_id: 1, hold_reason: 1, held_at: 1, 'stages.stage_key': 1, 'stages.status': 1 } },
    ).toArray(),
    masterNames(),
  ]);
  const defs = new Map(stageDefs().map((d) => [d.key, d]));
  const items: QueueItem[] = [];
  for (const r of rows) {
    const stage = defs.get(r.current_stage_key);
    const late = r.current_stage_planned_at && r.current_stage_planned_at < now ? diffMinutes(now, r.current_stage_planned_at) : null;
    const sev = (l: number | null, base: QueueItem['severity'] = 'medium'): QueueItem['severity'] => (l && l > 48 * 60 ? 'high' : l && l > 0 ? (base === 'low' ? 'medium' : base) : base);
    const push = (kind: string, severity: QueueItem['severity'], title: string, what: string, why: string, owner: string, action: string) =>
      items.push({ id: r._id, job_no: r.request_no, kind, severity, title: `${r.request_no} ${title}`, what, why, owner, late_minutes: late, action });
    const engineerName = names.engineers.get(r.assigned_engineer_id) ?? null;
    const siteEngineerName = names.engineers.get(r.site_engineer_id) ?? null;

    if (r.status === 'on_hold') {
      const heldDays = r.held_at ? (diffMinutes(now, r.held_at) ?? 0) / 1440 : 0;
      const rejected = (r.stages as { stage_key: string; status: string }[]).find((s) => s.status === 'rejected')?.stage_key;
      if (rejected) {
        push('rejected', 'high', `was rejected at ${stageName(rejected)}`, `The ${stageName(rejected)} decision was "rejected": ${r.hold_reason ?? ''}`,
          'A rejected approval puts the job on hold until the coordinator resolves it.', 'Process Coordinator', 'Resolve the objection, then Resume — or Cancel the job card.');
      } else if (heldDays >= 3) {
        push('hold', heldDays >= 7 ? 'high' : 'medium', `on hold for ${Math.floor(heldDays)} days`, `Job was put on hold: ${r.hold_reason ?? 'no reason given'}`,
          'On-hold jobs older than 3 days need a review.', 'Process Coordinator', 'Review the hold reason and Resume or Cancel.');
      }
      continue;
    }
    switch (r.current_stage_key) {
      case 'triage':
        push('approval', sev(late, 'medium'), 'is waiting for approval', 'New job card raised and not yet approved.',
          'Every new job card must be approved at Triage before a site visit.', 'Process Coordinator', 'Open the job card and Approve (set site engineer & dependencies) or Reject.');
        break;
      case 'site_visit':
        if (!r.site_engineer_id) {
          push('no_engineer', 'high', 'has no site engineer assigned', 'Job is at Site Visit but nobody is assigned to visit.',
            'Site engineer is empty while the job is waiting for a site visit.', 'Unassigned', 'Assign a site engineer now (Reassign).');
        } else if (late) {
          push('overdue', sev(late), 'site visit is overdue', 'Site visit is past its planned time and is not done.',
            'Current stage is past its planned time.', siteEngineerName ?? 'Site engineer', `Chase ${siteEngineerName ?? 'the site engineer'} to complete the site visit.`);
        }
        break;
      case 'engineer_assigned':
        push('assign', sev(late, 'medium'), 'needs an engineer to start work', 'All approvals are done; the work has not been handed to an engineer.',
          'Engineer Assigned is a coordinator step.', 'Process Coordinator', 'Assign the engineer and inform them to start.');
        break;
      case 'communicate_requester':
        push('inform', sev(late, 'low'), 'requester has not been informed', 'Site visit / discussion done; the person who raised the problem has not been updated.',
          'Requester Informed is a coordinator step.', 'Process Coordinator', 'Call / WhatsApp the requester, then mark Requester Informed.');
        break;
      case 'closed':
        push('close', sev(late, 'low'), 'is ready to close', 'Work is completed and verified.', 'Only the Process Coordinator can close a job card.',
          'Process Coordinator', 'Check the evidence and Close the job card with a closure category.');
        break;
      default:
        if (late && stage) {
          const workStage = ['work_started', 'work_completed'].includes(r.current_stage_key);
          const owner = workStage ? engineerName ?? 'Unassigned' : stage.responsibleLabel;
          const noEngineer = workStage && !r.assigned_engineer_id;
          push(noEngineer ? 'no_engineer' : 'overdue', noEngineer ? 'high' : sev(late), noEngineer ? 'has no engineer assigned' : `is overdue at ${stage.name}`,
            noEngineer ? 'Job is at the work stage but no engineer is assigned.' : `${stage.name} is not done and is past its planned time.`,
            `Planned ${String(r.current_stage_planned_at).replace('T', ' ').slice(0, 16)} — ${stage.name} is the current stage.`,
            owner, noEngineer ? 'Assign an engineer now (Reassign).' : `Chase ${owner} to complete ${stage.name}.`);
        }
    }
  }
  const rank = { high: 0, medium: 1, low: 2 };
  items.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.late_minutes ?? -1) - (a.late_minutes ?? -1));
  const counts: Record<string, number> = {};
  for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  const kind = typeof query.kind === 'string' && query.kind ? query.kind : null;
  return { total: items.length, counts, items: (kind ? items.filter((i) => i.kind === kind) : items).slice(0, 500) };
}
