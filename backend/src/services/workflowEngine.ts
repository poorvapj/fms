import { all, get, run } from '../db/db.ts';
import { computePlanned, deriveState, type StageKey, type StageLike } from '../domain/workflow.ts';
import { nowLocal } from '../utils/dates.ts';
import { stageDef, stageDefs } from './stageDefs.ts';

/** Create the full set of stage rows for a new UI request. */
export function createStageRows(requestId: number, requestedAt: string, userId: number | null, requesterName: string | null) {
  const now = nowLocal();
  for (const d of stageDefs()) {
    const isCreated = d.key === 'created';
    const planned = isCreated ? requestedAt : d.sla.type !== 'none' && d.sla.anchor === 'request' ? computePlanned(d.sla, requestedAt, null) : null;
    run(
      `INSERT INTO request_stages (request_id, stage_key, seq, status, planned_at, actual_at, delay_minutes, responsible_role, responsible_name, responsible_user_id, source, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ui', ?, ?)`,
      [
        requestId, d.key, d.seq, isCreated ? 'completed' : 'pending', planned, isCreated ? requestedAt : null, isCreated ? 0 : null,
        d.responsibleLabel, isCreated ? requesterName : null, isCreated ? userId : null, userId, now,
      ],
    );
  }
}

export interface RefreshOptions {
  /** Roll "same day" deadlines forward when already past (live records). */
  rollForward?: boolean;
}

/**
 * Re-derive current stage, status and denormalised fields for a request.
 * Activates the next pending stage (computing its SLA planned time) when nothing is active.
 */
export function refreshRequestState(requestId: number, opts: RefreshOptions = {}) {
  const req = get('SELECT id, requested_at, held_at, cancelled_at FROM requests WHERE id = ?', [requestId]);
  if (!req) return;
  const stages = all<StageLike & { id: number; actual_at: string | null }>(
    'SELECT id, stage_key, seq, status, planned_at, actual_at FROM request_stages WHERE request_id = ? ORDER BY seq',
    [requestId],
  );
  const cancelled = !!req.cancelled_at;
  const hasActive = stages.some((s) => s.status === 'active' || s.status === 'rejected');
  if (!hasActive && !cancelled) {
    const next = stages.find((s) => s.status === 'pending');
    if (next) {
      const prev = [...stages].reverse().find((s) => s.seq < next.seq && s.status === 'completed' && s.actual_at);
      const planned = next.planned_at ?? computePlanned(stageDef(next.stage_key).sla, req.requested_at, prev?.actual_at ?? null, opts.rollForward ?? true);
      run('UPDATE request_stages SET status = ?, planned_at = ? WHERE id = ?', ['active', planned, next.id]);
      next.status = 'active';
      next.planned_at = planned;
    }
  }
  const { current, status } = deriveState(stages, { held: !!req.held_at, cancelled });
  const byKey = new Map(stages.map((s) => [s.stage_key, s]));
  const done = (k: StageKey) => (byKey.get(k)?.status === 'completed' ? byKey.get(k)!.actual_at : null);
  run(
    `UPDATE requests SET status = ?, current_stage_key = ?, current_stage_planned_at = ?, completed_at = ?, closed_at = ? WHERE id = ?`,
    [
      status,
      status === 'closed' || status === 'cancelled' ? null : current?.stage_key ?? null,
      status === 'closed' || status === 'cancelled' ? null : current?.planned_at ?? null,
      done('work_completed'),
      status === 'closed' ? done('closed') ?? done('work_completed') : null,
      requestId,
    ],
  );
}
