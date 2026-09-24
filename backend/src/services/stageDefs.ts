import { all, run } from '../db/db.ts';
import type { Role } from '../domain/permissions.ts';
import { DEFAULT_STAGES, describeSla, type SlaRule, type StageDefinition, type StageKey } from '../domain/workflow.ts';
import { badRequest, notFound } from '../utils/http.ts';

let cache: StageDefinition[] | null = null;

/** Stage definitions with admin-editable fields (name, roles, SLA, evidence) taken from the database. */
export function stageDefs(): StageDefinition[] {
  if (cache) return cache;
  const rows = new Map(all('SELECT * FROM workflow_stages').map((r) => [r.key, r]));
  cache = DEFAULT_STAGES.map((d) => {
    const r = rows.get(d.key);
    if (!r) return d;
    return {
      ...d,
      name: r.name,
      roles: JSON.parse(r.action_roles) as Role[],
      responsibleLabel: r.responsible_label ?? d.responsibleLabel,
      sla: JSON.parse(r.sla_rule) as SlaRule,
      requiresEvidence: !!r.requires_evidence,
    };
  });
  return cache;
}

export function stageDef(key: string): StageDefinition {
  const d = stageDefs().find((s) => s.key === key);
  if (!d) throw notFound('Stage');
  return d;
}

export function stageName(key: string | null | undefined): string | null {
  if (!key) return null;
  return stageDefs().find((s) => s.key === key)?.name ?? key;
}

export function publicStageDefs() {
  return stageDefs().map((s) => ({
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

export function updateStageDef(key: StageKey, body: any) {
  stageDef(key);
  const sets: string[] = [];
  const params: any[] = [];
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) throw badRequest('Name is required');
    sets.push('name = ?'); params.push(name.slice(0, 80));
  }
  if (body.responsible_label !== undefined) { sets.push('responsible_label = ?'); params.push(String(body.responsible_label).slice(0, 80)); }
  if (body.requires_evidence !== undefined) { sets.push('requires_evidence = ?'); params.push(body.requires_evidence ? 1 : 0); }
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
    sets.push('sla_rule = ?'); params.push(JSON.stringify(rule));
  }
  if (!sets.length) return;
  params.push(key);
  run(`UPDATE workflow_stages SET ${sets.join(', ')} WHERE key = ?`, params);
  cache = null;
}
