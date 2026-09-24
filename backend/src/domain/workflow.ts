import { addWorkingDays, atTime, formatMs, isWorkingDay, nextWorkingDay, toMs } from '../utils/dates.ts';
import type { Role } from './permissions.ts';

export type StageKey =
  | 'created' | 'triage' | 'site_visit' | 'ph_discussion' | 'material' | 'communicate_requester'
  | 'permission' | 'engineer_assigned' | 'work_started' | 'work_completed' | 'verification' | 'closed';

export type StageGroup = 'intake' | 'assessment' | 'dependency' | 'coordination' | 'execution' | 'closure';

export type StageStatus = 'pending' | 'active' | 'completed' | 'skipped' | 'rejected';

export type RequestStatus =
  | 'open' | 'in_progress' | 'pending_action' | 'pending_approval' | 'on_hold' | 'completed' | 'closed' | 'cancelled';

export type SlaRule =
  | { type: 'none' }
  | { type: 'add_hours'; hours: number; anchor: 'request' | 'previous' }
  | { type: 'next_day_at'; time: string; anchor: 'request' | 'previous' }
  | { type: 'same_day_at'; time: string; anchor: 'request' | 'previous' }
  | { type: 'add_working_days'; days: number; anchor: 'request' | 'previous' };

export interface StageDefinition {
  key: StageKey;
  seq: number;
  name: string;
  group: StageGroup;
  optional: boolean;
  /** Roles allowed to act. "engineer" is further restricted to the engineer bound to the stage. */
  roles: Role[];
  responsibleLabel: string;
  sla: SlaRule;
  requiresEvidence: boolean;
  /** Dependency stages support approve / reject decisions. */
  decision: boolean;
  /** Request flag that switches an optional stage on. */
  flag?: 'requires_ph_discussion' | 'requires_material' | 'requires_permission';
  legacyName?: string;
}

export const DEFAULT_STAGES: StageDefinition[] = [
  { key: 'created', seq: 1, name: 'Request Created', group: 'intake', optional: false, roles: [], responsibleLabel: 'Requester', sla: { type: 'none' }, requiresEvidence: false, decision: false },
  { key: 'triage', seq: 2, name: 'Triage & Approval', group: 'intake', optional: false, roles: ['admin', 'coordinator'], responsibleLabel: 'Process Coordinator', sla: { type: 'add_hours', hours: 4, anchor: 'request' }, requiresEvidence: false, decision: true },
  { key: 'site_visit', seq: 3, name: 'Site Visit', group: 'assessment', optional: false, roles: ['admin', 'coordinator', 'project_head', 'engineer'], responsibleLabel: 'Site Engineer', sla: { type: 'next_day_at', time: '15:00', anchor: 'request' }, requiresEvidence: false, decision: false, legacyName: 'Site Visit' },
  { key: 'ph_discussion', seq: 4, name: 'Project Head Discussion', group: 'dependency', optional: true, roles: ['admin', 'coordinator', 'project_head'], responsibleLabel: 'Project Head', sla: { type: 'same_day_at', time: '18:00', anchor: 'previous' }, requiresEvidence: false, decision: true, flag: 'requires_ph_discussion', legacyName: 'Discussion with Project Head' },
  { key: 'material', seq: 5, name: 'Material / Dependency', group: 'dependency', optional: true, roles: ['admin', 'coordinator', 'store'], responsibleLabel: 'Store', sla: { type: 'add_working_days', days: 1, anchor: 'previous' }, requiresEvidence: false, decision: true, flag: 'requires_material', legacyName: 'Material Update' },
  { key: 'communicate_requester', seq: 6, name: 'Requester Informed', group: 'coordination', optional: false, roles: ['admin', 'coordinator'], responsibleLabel: 'Coordinator', sla: { type: 'next_day_at', time: '10:00', anchor: 'previous' }, requiresEvidence: false, decision: false, legacyName: 'Communicate to Problem Raised' },
  { key: 'permission', seq: 7, name: 'Permission / Approval', group: 'dependency', optional: true, roles: ['admin', 'coordinator', 'approver'], responsibleLabel: 'Approver', sla: { type: 'same_day_at', time: '11:00', anchor: 'previous' }, requiresEvidence: false, decision: true, flag: 'requires_permission', legacyName: 'Get Permission' },
  { key: 'engineer_assigned', seq: 8, name: 'Engineer Assigned', group: 'coordination', optional: false, roles: ['admin', 'coordinator'], responsibleLabel: 'Coordinator', sla: { type: 'same_day_at', time: '12:00', anchor: 'previous' }, requiresEvidence: false, decision: false, legacyName: 'Communicate to Engineer to Start' },
  { key: 'work_started', seq: 9, name: 'Work Started', group: 'execution', optional: false, roles: ['admin', 'coordinator', 'engineer'], responsibleLabel: 'Assigned Engineer', sla: { type: 'next_day_at', time: '10:00', anchor: 'previous' }, requiresEvidence: false, decision: false },
  { key: 'work_completed', seq: 10, name: 'Work Completed', group: 'execution', optional: false, roles: ['admin', 'coordinator', 'engineer'], responsibleLabel: 'Assigned Engineer', sla: { type: 'add_working_days', days: 7, anchor: 'request' }, requiresEvidence: true, decision: false, legacyName: 'Work Completion' },
  { key: 'verification', seq: 11, name: 'Verification', group: 'closure', optional: false, roles: ['admin', 'coordinator', 'project_head'], responsibleLabel: 'Project Head / Coordinator', sla: { type: 'add_working_days', days: 1, anchor: 'previous' }, requiresEvidence: false, decision: true },
  { key: 'closed', seq: 12, name: 'Closed', group: 'closure', optional: false, roles: ['admin', 'coordinator'], responsibleLabel: 'Process Coordinator', sla: { type: 'same_day_at', time: '18:00', anchor: 'previous' }, requiresEvidence: false, decision: false },
];

export const STAGE_KEYS = DEFAULT_STAGES.map((s) => s.key);

/** Stages that exist in the legacy FMS sheet, in sheet order. */
export const LEGACY_STAGE_KEYS: StageKey[] = [
  'site_visit', 'ph_discussion', 'material', 'communicate_requester', 'permission', 'engineer_assigned', 'work_completed',
];

export const WEEKLY_OFF = [0]; // Sunday, as in the FMS sheet

export const REQUEST_STATUSES: { key: RequestStatus; label: string }[] = [
  { key: 'open', label: 'Raised' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'pending_action', label: 'Pending Action' },
  { key: 'pending_approval', label: 'Pending Approval' },
  { key: 'on_hold', label: 'On Hold' },
  { key: 'completed', label: 'Completed' },
  { key: 'closed', label: 'Closed' },
  { key: 'cancelled', label: 'Cancelled' },
];

/** "Work" question of the Job Card-Work Capture Form. */
export const WORK_TYPES = [
  { key: 'new_work', label: 'New Work' },
  { key: 'maintenance', label: 'Maintenance' },
] as const;

export function normalizeWorkType(v: unknown): string | null {
  const s = String(v ?? '').toLowerCase();
  if (/new/.test(s)) return 'new_work';
  if (/maint/.test(s)) return 'maintenance';
  return null;
}

export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * Compute planned time for a stage.
 * @param rollForward For live records: a "same day" deadline already passed on the anchor day moves to the next working day.
 *                    The legacy sheet did not do this, so the importer passes false.
 */
export function computePlanned(rule: SlaRule, requestAt: string | null, previousAt: string | null, rollForward = true): string | null {
  if (rule.type === 'none') return null;
  const anchor = toMs(rule.anchor === 'request' ? requestAt : previousAt ?? requestAt);
  if (anchor === null) return null;
  switch (rule.type) {
    case 'add_hours':
      return formatMs(anchor + rule.hours * 3600000);
    case 'next_day_at':
      return formatMs(atTime(nextWorkingDay(anchor, WEEKLY_OFF), rule.time));
    case 'same_day_at': {
      let day = anchor;
      if (!isWorkingDay(day, WEEKLY_OFF)) day = nextWorkingDay(day, WEEKLY_OFF);
      let t = atTime(day, rule.time);
      if (rollForward && t < anchor) t = atTime(nextWorkingDay(day, WEEKLY_OFF), rule.time);
      return formatMs(t);
    }
    case 'add_working_days':
      return formatMs(addWorkingDays(anchor, rule.days, WEEKLY_OFF));
  }
}

export function describeSla(rule: SlaRule): string {
  const from = 'anchor' in rule ? (rule.anchor === 'request' ? 'after request' : 'after previous stage') : '';
  switch (rule.type) {
    case 'none': return 'No SLA';
    case 'add_hours': return `${rule.hours} h ${from}`;
    case 'next_day_at': return `Next working day ${rule.time} ${from}`;
    case 'same_day_at': return `Same day ${rule.time} ${from}`;
    case 'add_working_days': return `${rule.days} working day(s) ${from}`;
  }
}

export interface StageLike {
  stage_key: StageKey;
  seq: number;
  status: StageStatus;
  planned_at: string | null;
}

const STATUS_BY_GROUP: Record<StageKey, RequestStatus> = {
  created: 'open',
  triage: 'open',
  site_visit: 'in_progress',
  ph_discussion: 'pending_approval',
  material: 'pending_approval',
  communicate_requester: 'pending_action',
  permission: 'pending_approval',
  engineer_assigned: 'pending_action',
  work_started: 'in_progress',
  work_completed: 'in_progress',
  verification: 'completed',
  closed: 'completed',
};

/** Derive current stage and request status from stage rows. */
export function deriveState(
  stages: StageLike[],
  flags: { held: boolean; cancelled: boolean },
): { current: StageLike | null; status: RequestStatus } {
  const ordered = [...stages].sort((a, b) => a.seq - b.seq);
  const current = ordered.find((s) => s.status === 'active' || s.status === 'rejected')
    ?? ordered.find((s) => s.status === 'pending')
    ?? null;
  const closedStage = ordered.find((s) => s.stage_key === 'closed');
  if (flags.cancelled) return { current, status: 'cancelled' };
  if (closedStage?.status === 'completed') return { current: null, status: 'closed' };
  if (flags.held) return { current, status: 'on_hold' };
  if (!current) return { current: null, status: 'closed' };
  return { current, status: STATUS_BY_GROUP[current.stage_key] };
}

export function isDelayMinutesLate(delay: number | null | undefined): boolean {
  return typeof delay === 'number' && delay > 0;
}
