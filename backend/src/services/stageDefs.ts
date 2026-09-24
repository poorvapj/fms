import { col } from '../db/mongo.ts';
import type { Role } from '../domain/permissions.ts';
import { DEFAULT_STAGES, describeSla, type SlaRule, type StageDefinition, type StageKey } from '../domain/workflow.ts';
import { badRequest, notFound } from '../utils/http.ts';

let cache: StageDefinition[] = DEFAULT_STAGES;

/** Ensure every stage exists in the database (keeps admin edits) and load the cache. Call at startup. */
export async function loadStageDefs() {
  for (const s of DEFAULT_STAGES) {
    await col.workflowStages().updateOne(
      { _id: s.key },
      {
        $setOnInsert: { name: s.name, action_roles: s.roles, responsible_label: s.responsibleLabel, sla_rule: s.sla, requires_evidence: s.requiresEvidence },
        $set: { seq: s.seq, stage_group: s.group, optional: s.optional, decision: s.decision, legacy_name: s.legacyName ?? null },
      },
      { upsert: true },
    );
  }
  const rows = new Map((await col.workflowStages().find().toArray()).map((r) => [r._id, r]));
  cache = DEFAULT_STAGES.map((d) => {
    const r = rows.get(d.key);
    if (!r) return d;
    return {
      ...d,
      name: r.name ?? d.name,
      roles: (r.action_roles as Role[]) ?? d.roles,
      responsibleLabel: r.responsible_label ?? d.responsibleLabel,
      sla: (r.sla_rule as SlaRule) ?? d.sla,
      requiresEvidence: !!r.requires_evidence,
    };
  });
}

/** Stage definitions with admin-editable fields (name, roles, SLA, evidence). */
export function stageDefs(): StageDefinition[] {
  return cache;
}

export function stageDef(key: string): StageDefinition {
  const d = cache.find((s) => s.key === key);
  if (!d) throw notFound('Stage');
  return d;
}

export function stageName(key: string | null | undefined): string | null {
  if (!key) return null;
  return cache.find((s) => s.key === key)?.name ?? key;
}

export function publicStageDefs() {
  return cache.map((s) => ({
    key: s.key,
    seq: s.seq,
    name: s.name,
    group: s.group,
    optional: s.optional,
    roles: s.roles,
    responsible_label: s.responsibleLabel,
    sla: s.sla,
    sla_text: describeSla(s.sla),
    requires_evidence: s.requiresEvidence,
    decision: s.decision,
    legacy_name: s.legacyName ?? null,
  }));
}

const RULE_TYPES = ['none', 'add_hours', 'next_day_at', 'same_day_at', 'add_working_days'];

export async function updateStageDef(key: StageKey, body: any) {
  stageDef(key);
  const set: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) throw badRequest('Name is required');
    set.name = name.slice(0, 80);
  }
  if (body.responsible_label !== undefined) set.responsible_label = String(body.responsible_label).slice(0, 80);
  if (body.requires_evidence !== undefined) set.requires_evidence = !!body.requires_evidence;
  if (body.sla !== undefined) {
    const r = body.sla;
    if (!r || !RULE_TYPES.includes(r.type)) throw badRequest('Invalid SLA rule type');
    const anchor = r.anchor === 'request' ? 'request' : 'previous';
    let rule: SlaRule;
    const time = /^\d{2}:\d{2}$/.test(r.time ?? '') ? r.time : null;
    switch (r.type) {
      case 'none': rule = { type: 'none' }; break;
      case 'add_hours': {
        const hours = Number(r.hours);
        if (!(hours > 0 && hours <= 720)) throw badRequest('Hours must be between 1 and 720');
        rule = { type: 'add_hours', hours, anchor }; break;
      }
      case 'add_working_days': {
        const days = Number(r.days);
        if (!(Number.isInteger(days) && days >= 0 && days <= 90)) throw badRequest('Days must be between 0 and 90');
        rule = { type: 'add_working_days', days, anchor }; break;
      }
      default:
        if (!time) throw badRequest('Time must be HH:MM');
        rule = { type: r.type, time, anchor };
    }
    set.sla_rule = rule;
  }
  if (!Object.keys(set).length) return;
  await col.workflowStages().updateOne({ _id: key }, { $set: set });
  await loadStageDefs();
}
