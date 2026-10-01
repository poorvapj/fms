import { col, nextId, withId } from '../db/mongo.ts';
import { PRIORITIES } from '../domain/workflow.ts';
import { badRequest, int, notFound, oneOf, str } from '../utils/http.ts';

/**
 * Whole-job SLA override layer, additional to the existing per-stage `SlaRule` on each stage
 * definition (see domain/workflow.ts + services/stageDefs.ts, which remain the engine that
 * actually computes `planned_at`). This collection is persisted and readable via the API below so
 * the "SLA Rules" admin tab is fully functional as CRUD, matching the reference's resolution order
 * (Priority → Category → Project → Global → 48h fallback) as *data*.
 *
 * TODO (not done in this pass): wire `resolveSlaHours()` below into workflowEngine.computePlanned /
 * refreshState as an override of the stage-level SLA, if/when the product wants whole-job SLA
 * overrides to take priority over per-stage rules. Left unwired to avoid destabilising the live
 * per-stage SLA engine that job-card creation and stage completion already depend on.
 */

const SCOPES = ['priority', 'category', 'property', 'global'] as const;
export type SlaScope = (typeof SCOPES)[number];

export async function listSlaRules() {
  return (await col.slaRules().find().sort({ scope: 1 }).toArray()).map(withId);
}

export async function createSlaRule(body: any) {
  const scope = oneOf(body.scope, SCOPES, 'Scope');
  const scopeValue = scope === 'global' ? null : (str(body.scope_value, 80) ?? (() => { throw badRequest('Scope value is required for this scope'); })());
  const stageKey = str(body.stage_key, 40);
  const hours = Number(body.hours);
  if (!(hours > 0 && hours <= 10000)) throw badRequest('Hours must be a positive number');
  if (scope === 'priority' && !PRIORITIES.includes(scopeValue as any)) throw badRequest(`Scope value must be one of: ${PRIORITIES.join(', ')}`);
  const doc = { _id: await nextId('sla_rules'), scope, scope_value: scopeValue, stage_key: stageKey, hours };
  await col.slaRules().insertOne(doc);
  return withId(doc);
}

export async function deleteSlaRule(id: number) {
  const r = await col.slaRules().deleteOne({ _id: id });
  if (!r.deletedCount) throw notFound('SLA rule');
}

/** Resolution order: Priority → Category → Project → Global → 48h fallback (not yet wired into the live engine; see TODO above). */
export async function resolveSlaHours(opts: { priority?: string | null; category_id?: number | null; property_id?: number | null; stage_key?: string | null }): Promise<number> {
  const rules = await listSlaRules();
  const match = (scope: SlaScope, value: unknown) => rules.find((r: any) => r.scope === scope && String(r.scope_value) === String(value) && (!r.stage_key || r.stage_key === opts.stage_key));
  const found = (opts.priority && match('priority', opts.priority))
    ?? (opts.category_id && match('category', opts.category_id))
    ?? (opts.property_id && match('property', opts.property_id))
    ?? rules.find((r: any) => r.scope === 'global' && (!r.stage_key || r.stage_key === opts.stage_key));
  return (found as any)?.hours ?? 48;
}
