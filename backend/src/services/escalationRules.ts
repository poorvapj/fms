import { col, nextId, withId } from '../db/mongo.ts';
import { ROLES } from '../domain/permissions.ts';
import { badRequest, bool, notFound, oneOf, str } from '../utils/http.ts';

export const TRIGGERS = ['APPROVAL_OVERDUE', 'MATERIAL_BLOCKED', 'NO_UPDATE', 'HOLD_STALE'] as const;
export type Trigger = (typeof TRIGGERS)[number];

/** Documented defaults that apply until an active rule exists for a trigger type (mirrors dashboard.ts's old hardcoded numbers). */
const DEFAULT_THRESHOLD_HOURS: Record<Trigger, number> = {
  APPROVAL_OVERDUE: 48,
  MATERIAL_BLOCKED: 48,
  NO_UPDATE: 48,
  HOLD_STALE: 72, // 3 days, as in the previous hardcoded `heldDays >= 3`
};

interface EscalationRuleDoc {
  _id: number;
  trigger: Trigger;
  threshold_hours: number;
  escalate_to_role: string;
  active: boolean;
}

let cache: EscalationRuleDoc[] = [];

export async function loadEscalationRules() {
  cache = await col.escalationRules().find().toArray() as EscalationRuleDoc[];
}

export async function listEscalationRules() {
  return (await col.escalationRules().find().sort({ trigger: 1 }).toArray()).map(withId);
}

export async function createEscalationRule(body: any) {
  const trigger = oneOf(body.trigger, TRIGGERS, 'Trigger');
  const threshold = Number(body.threshold_hours);
  if (!(threshold > 0 && threshold <= 24 * 60)) throw badRequest('Threshold hours must be between 1 and 1440');
  const role = oneOf(body.escalate_to_role, ROLES, 'Escalate to role');
  const doc: EscalationRuleDoc = { _id: await nextId('escalation_rules'), trigger, threshold_hours: threshold, escalate_to_role: role, active: true };
  await col.escalationRules().insertOne(doc);
  await loadEscalationRules();
  return withId(doc);
}

export async function updateEscalationRule(id: number, body: any) {
  const set: Record<string, unknown> = {};
  if (body.threshold_hours !== undefined) {
    const t = Number(body.threshold_hours);
    if (!(t > 0 && t <= 24 * 60)) throw badRequest('Threshold hours must be between 1 and 1440');
    set.threshold_hours = t;
  }
  if (body.escalate_to_role !== undefined) set.escalate_to_role = oneOf(body.escalate_to_role, ROLES, 'Escalate to role');
  if (body.active !== undefined) set.active = !!bool(body.active);
  const r = await col.escalationRules().updateOne({ _id: id }, { $set: set });
  if (!r.matchedCount) throw notFound('Escalation rule');
  await loadEscalationRules();
}

export async function deleteEscalationRule(id: number) {
  const r = await col.escalationRules().deleteOne({ _id: id });
  if (!r.deletedCount) throw notFound('Escalation rule');
  await loadEscalationRules();
}

/**
 * Threshold (in hours) for a trigger type: an active configured rule wins, otherwise the
 * documented default. Used by services/dashboard.ts coordinatorQueue() in place of the hardcoded
 * 48h / 72h("3 days") numbers it used to have.
 */
export function thresholdHoursFor(trigger: Trigger): number {
  const rule = cache.find((r) => r.trigger === trigger && r.active);
  return rule?.threshold_hours ?? DEFAULT_THRESHOLD_HOURS[trigger];
}

export function roleFor(trigger: Trigger): string | null {
  return cache.find((r) => r.trigger === trigger && r.active)?.escalate_to_role ?? null;
}
