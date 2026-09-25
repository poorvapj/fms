import { col, type Doc } from '../db/mongo.ts';
import { computePlanned, deriveState, type StageKey, type StageStatus } from '../domain/workflow.ts';
import { nowLocal } from '../utils/dates.ts';
import { conflict } from '../utils/http.ts';
import { stageDef, stageDefs } from './stageDefs.ts';

/** A workflow stage embedded in a job card document (`requests.stages[]`). */
export interface StageDoc {
  stage_key: StageKey;
  seq: number;
  status: StageStatus;
  planned_at: string | null;
  actual_at: string | null;
  delay_minutes: number | null;
  responsible_role: string | null;
  responsible_name: string | null;
  responsible_user_id: number | null;
  engineer_id: number | null;
  decision: string | null;
  comments: string | null;
  /** Set when an engineer reports a problem (e.g. "No" on the Slack site-visit prompt) — shows a red flag until the stage is actually completed. */
  attention: boolean;
  planned_inferred: boolean;
  actual_inferred: boolean;
  source: 'ui' | 'fms_import' | 'system' | 'public';
  legacy: Record<string, string> | null;
  updated_by: number | null;
  updated_at: string;
}

export type RequestDoc = Doc & { _id: number; stages: StageDoc[] };

export function blankStage(key: StageKey, seq: number, now: string): StageDoc {
  return {
    stage_key: key, seq, status: 'pending', planned_at: null, actual_at: null, delay_minutes: null, responsible_role: null,
    responsible_name: null, responsible_user_id: null, engineer_id: null, decision: null, comments: null, attention: false,
    planned_inferred: false, actual_inferred: false, source: 'ui', legacy: null, updated_by: null, updated_at: now,
  };
}

/** Full set of stage rows for a new job card raised in the app / public form. */
export function newStages(requestedAt: string, userId: number | null, requesterName: string | null): StageDoc[] {
  const now = nowLocal();
  return stageDefs().map((d) => {
    const s = blankStage(d.key, d.seq, now);
    s.responsible_role = d.responsibleLabel;
    s.updated_by = userId;
    if (d.key === 'created') {
      Object.assign(s, { status: 'completed', planned_at: requestedAt, actual_at: requestedAt, delay_minutes: 0, responsible_name: requesterName, responsible_user_id: userId });
    } else if (d.sla.type !== 'none' && d.sla.anchor === 'request') {
      s.planned_at = computePlanned(d.sla, requestedAt, null);
    }
    return s;
  });
}

export function stageOf(doc: RequestDoc, key: string): StageDoc {
  const s = doc.stages.find((x) => x.stage_key === key);
  if (!s) throw conflict('Stage not found on this job card');
  return s;
}

/**
 * Re-derive current stage, status and denormalised fields on a job card document (in memory).
 * Activates the next pending stage (computing its SLA planned time) when nothing is active.
 */
export function refreshState(doc: RequestDoc, opts: { rollForward?: boolean } = {}) {
  const stages = [...doc.stages].sort((a, b) => a.seq - b.seq);
  const cancelled = !!doc.cancelled_at;
  const hasActive = stages.some((s) => s.status === 'active' || s.status === 'rejected');
  if (!hasActive && !cancelled) {
    const next = stages.find((s) => s.status === 'pending');
    if (next) {
      const prev = [...stages].reverse().find((s) => s.seq < next.seq && s.status === 'completed' && s.actual_at);
      next.planned_at = next.planned_at ?? computePlanned(stageDef(next.stage_key).sla, doc.requested_at, prev?.actual_at ?? null, opts.rollForward ?? true);
      next.status = 'active';
    }
  }
  const { current, status } = deriveState(stages, { held: !!doc.held_at, cancelled });
  const done = (k: StageKey) => {
    const s = stages.find((x) => x.stage_key === k);
    return s?.status === 'completed' ? s.actual_at : null;
  };
  const finished = status === 'closed' || status === 'cancelled';
  doc.status = status;
  doc.current_stage_key = finished ? null : current?.stage_key ?? null;
  doc.current_stage_planned_at = finished ? null : current?.planned_at ?? null;
  doc.completed_at = done('work_completed');
  doc.closed_at = status === 'closed' ? done('closed') ?? done('work_completed') : null;
  doc.stages = stages;
  return doc;
}

/**
 * Persist a job card changed in memory. Fails if someone else saved it in the meantime
 * (optimistic concurrency on `version`), so concurrent edits are never silently lost.
 */
export async function saveRequest(doc: RequestDoc, opts: { modified?: boolean } = {}) {
  const loaded = doc.version ?? 0;
  doc.version = loaded + 1;
  doc.updated_at = nowLocal();
  if (opts.modified !== false) doc.modified_in_app = true;
  const filter = loaded ? { _id: doc._id, version: loaded } : { _id: doc._id, version: { $exists: false } };
  const r = await col.requests().replaceOne(filter, doc);
  if (!r.matchedCount) {
    doc.version = loaded;
    throw conflict('This job card was just updated by someone else. Reload and try again.');
  }
}
