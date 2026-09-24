import type { AuthUser } from '../auth/auth.ts';
import { all, get } from '../db/db.ts';
import type { Role } from '../domain/permissions.ts';
import type { StageKey } from '../domain/workflow.ts';
import { diffMinutes, formatMs, nowLocal, todayLocal, toMs } from '../utils/dates.ts';
import { buildFilter, decorate, LIST_SELECT, OVERDUE_SQL, scopeSql } from './requests.ts';
import { stageDefs, stageName } from './stageDefs.ts';

const ACTIVE = `r.status IN ('open','in_progress','pending_action','pending_approval','completed')`;
/** Open = everything not closed or cancelled (on-hold jobs are still open). */
const OPEN = `r.status NOT IN ('closed','cancelled')`;
/** Due later today and not yet overdue (overdue jobs are counted under Overdue). */
const DUE_TODAY = `(${ACTIVE} AND substr(r.current_stage_planned_at, 1, 10) = :today AND r.current_stage_planned_at >= :now)`;
const WAITING_MATERIAL = `(${ACTIVE} AND r.current_stage_key = 'material')`;
const WAITING_APPROVAL = `(${ACTIVE} AND r.current_stage_key IN ('triage','ph_discussion','permission'))`;
const VERIFICATION = `(${ACTIVE} AND r.current_stage_key IN ('verification','closed'))`;
const REOPENED = `EXISTS (SELECT 1 FROM request_events ev WHERE ev.request_id = r.id AND ev.type = 'reopen' AND ev.message LIKE 'Reopened%')`;

const HEALTH_DIMENSIONS: Record<string, { join: string; id: string; name: string }> = {
  property: { join: 'JOIN properties p ON p.id = r.property_id', id: 'p.id', name: 'p.name' },
  category: { join: 'JOIN work_categories c ON c.id = r.category_id', id: 'c.id', name: 'c.name' },
  engineer: { join: 'LEFT JOIN engineers e ON e.id = COALESCE(r.assigned_engineer_id, r.site_engineer_id)', id: 'e.id', name: 'e.name' },
};

export function dashboard(query: Record<string, any>, user: AuthUser) {
  const { where, params } = buildFilter(query, user);
  const p = { ...params, today: todayLocal(), since30: formatMs(toMs(nowLocal())! - 30 * 86400000) };
  const kpi = get(
    `SELECT COUNT(*) AS total,
       SUM(${OPEN}) AS open_jobs,
       SUM(${DUE_TODAY}) AS due_today,
       SUM(${OVERDUE_SQL}) AS overdue,
       SUM(${WAITING_MATERIAL}) AS waiting_material,
       SUM(${WAITING_APPROVAL}) AS waiting_approval,
       SUM(r.status = 'in_progress') AS in_progress,
       SUM(${VERIFICATION}) AS verification_pending,
       SUM(r.status = 'closed' AND r.closed_at >= :since30) AS closed_30d,
       SUM(r.status = 'closed') AS closed,
       SUM(r.status = 'on_hold') AS on_hold,
       SUM(${REOPENED}) AS reopened
     FROM requests r WHERE ${where}`,
    p,
  )!;
  for (const k of Object.keys(kpi)) kpi[k] = Number(kpi[k] ?? 0);

  const dim = HEALTH_DIMENSIONS[query.group_by] ?? HEALTH_DIMENSIONS.property;
  const health = all(
    `SELECT ${dim.id} AS id, COALESCE(${dim.name}, 'Unassigned') AS name,
       SUM(${OPEN}) AS open, SUM(${OVERDUE_SQL}) AS overdue, SUM(${DUE_TODAY}) AS due_today,
       SUM(${WAITING_MATERIAL}) AS waiting_material, SUM(${WAITING_APPROVAL}) AS waiting_approval,
       SUM(r.status = 'closed') AS closed, SUM(${REOPENED}) AS reopened, COUNT(*) AS total
     FROM requests r ${dim.join} WHERE ${where} GROUP BY ${dim.id} ORDER BY open DESC, overdue DESC, name`,
    p,
  ).map((r) => ({ ...r, reopen_rate: r.closed ? Math.round((Number(r.reopened) / Number(r.closed)) * 1000) / 10 : 0 }));

  return { kpi, health, group_by: query.group_by in HEALTH_DIMENSIONS ? query.group_by : 'property' };
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
export function myJobs(_query: Record<string, any>, user: AuthUser) {
  const now = nowLocal();
  const params: Record<string, any> = { now, eng: user.engineer_id ?? -1 };
  let actionable: string;
  let involved: string;
  if (user.role === 'engineer') {
    actionable = `((r.current_stage_key = 'site_visit' AND r.site_engineer_id = :eng) OR (r.current_stage_key IN ('work_started','work_completed') AND r.assigned_engineer_id = :eng))`;
    involved = `(r.assigned_engineer_id = :eng OR r.site_engineer_id = :eng)`;
  } else {
    const keys = ROLE_QUEUE[user.role] ?? [];
    actionable = keys.length ? `r.current_stage_key IN (${keys.map((k) => `'${k}'`).join(',')})` : '0';
    involved = actionable;
  }
  const mine = all(`${LIST_SELECT} WHERE ${ACTIVE} AND ${actionable} ORDER BY r.current_stage_planned_at IS NULL, r.current_stage_planned_at LIMIT 500`, params)
    .map((r) => decorate(r, now));
  const blocked = all(
    `${LIST_SELECT} WHERE (${involved}) AND NOT (${actionable}) AND (r.status IN ('on_hold','pending_approval')) ORDER BY r.requested_at DESC LIMIT 200`,
    params,
  ).map((r) => decorate(r, now));
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
 * Process Coordinator exception queue: every live job card that needs a coordinator decision or chasing,
 * with what happened, why it was flagged, who owns it and what to do next.
 */
export function coordinatorQueue(query: Record<string, any>, user: AuthUser) {
  const scope = scopeSql(user);
  const now = nowLocal();
  const rows = all(
    `SELECT r.id, r.request_no, r.status, r.current_stage_key, r.current_stage_planned_at, r.site_engineer_id, r.assigned_engineer_id,
            r.hold_reason, r.held_at, e.name AS engineer_name, se.name AS site_engineer_name, p.name AS property_name,
            (SELECT x.stage_key FROM request_stages x WHERE x.request_id = r.id AND x.status = 'rejected' LIMIT 1) AS rejected_stage
     FROM requests r JOIN properties p ON p.id = r.property_id
     LEFT JOIN engineers e ON e.id = r.assigned_engineer_id LEFT JOIN engineers se ON se.id = r.site_engineer_id
     WHERE ${scope.sql} AND (${ACTIVE} OR r.status = 'on_hold')`,
    scope.params,
  );
  const defs = new Map(stageDefs().map((d) => [d.key, d]));
  const items: QueueItem[] = [];
  for (const r of rows) {
    const stage = defs.get(r.current_stage_key);
    const late = r.current_stage_planned_at && r.current_stage_planned_at < now ? diffMinutes(now, r.current_stage_planned_at) : null;
    const sev = (l: number | null, base: QueueItem['severity'] = 'medium'): QueueItem['severity'] => (l && l > 48 * 60 ? 'high' : l && l > 0 ? (base === 'low' ? 'medium' : base) : base);
    const push = (kind: string, severity: QueueItem['severity'], title: string, what: string, why: string, owner: string, action: string) =>
      items.push({ id: r.id, job_no: r.request_no, kind, severity, title: `${r.request_no} ${title}`, what, why, owner, late_minutes: late, action });

    if (r.status === 'on_hold') {
      const heldDays = r.held_at ? (diffMinutes(now, r.held_at) ?? 0) / 1440 : 0;
      if (r.rejected_stage) {
        push('rejected', 'high', `was rejected at ${stageName(r.rejected_stage)}`, `The ${stageName(r.rejected_stage)} decision was "rejected": ${r.hold_reason ?? ''}`,
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
          push('overdue', sev(late), 'site visit is overdue', `Site visit was due ${stageName('site_visit')} by the SLA and is not done.`,
            'Current stage is past its planned time.', r.site_engineer_name, `Chase ${r.site_engineer_name} to complete the site visit.`);
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
          const owner = ['work_started', 'work_completed'].includes(r.current_stage_key) ? r.engineer_name ?? 'Unassigned' : stage.responsibleLabel;
          const noEngineer = ['work_started', 'work_completed'].includes(r.current_stage_key) && !r.assigned_engineer_id;
          push(noEngineer ? 'no_engineer' : 'overdue', noEngineer ? 'high' : sev(late), noEngineer ? 'has no engineer assigned' : `is overdue at ${stage.name}`,
            noEngineer ? 'Job is at the work stage but no engineer is assigned.' : `${stage.name} is not done and is past its planned time.`,
            `Planned ${r.current_stage_planned_at.replace('T', ' ').slice(0, 16)} — ${stage.name} is the current stage.`,
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
