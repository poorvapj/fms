import type { AuthUser } from '../auth/auth.ts';
import { all, get, run, tx, type Row } from '../db/db.ts';
import { can } from '../domain/permissions.ts';
import { PRIORITIES, WEEKLY_OFF, type StageDefinition, type StageKey } from '../domain/workflow.ts';
import { addWorkingDays, diffMinutes, formatMs, normalizeLocal, nowLocal, toMs } from '../utils/dates.ts';
import { badRequest, bool, conflict, forbidden, int, oneOf, requiredStr, str } from '../utils/http.ts';
import { logEvent } from './events.ts';
import { assertCanView, loadRequest } from './requests.ts';
import { stageDef, stageDefs } from './stageDefs.ts';
import { refreshRequestState } from './workflowEngine.ts';

function loadStage(requestId: number, key: string): Row {
  const s = get('SELECT * FROM request_stages WHERE request_id = ? AND stage_key = ?', [requestId, key]);
  if (!s) throw badRequest('Stage not found on this request');
  return s;
}

/** Whether a user may act on a stage of a request (role + engineer binding). */
export function canActOnStage(user: AuthUser, def: StageDefinition, r: Row, stage: Row | null): boolean {
  if (!can(user.role, 'stage.update') || !def.roles.includes(user.role)) return false;
  if (user.role !== 'engineer') return true;
  if (!user.engineer_id) return false;
  if (def.key === 'site_visit') return r.site_engineer_id === user.engineer_id || stage?.engineer_id === user.engineer_id;
  return r.assigned_engineer_id === user.engineer_id || stage?.engineer_id === user.engineer_id;
}

function assertLive(r: Row) {
  if (r.cancelled_at) throw conflict('Job card is cancelled');
  if (r.status === 'closed') throw conflict('Job card is closed. Reopen it first.');
  if (r.held_at) throw conflict('Job card is on hold. Resume it first.');
}

function resolveActual(body: any, r: Row, user: AuthUser): string {
  const now = nowLocal();
  if (!body.actual_at) return now;
  const at = normalizeLocal(body.actual_at);
  if (!at) throw badRequest('Invalid actual date/time');
  if (at > now) throw badRequest('Actual date/time cannot be in the future');
  if (at < r.requested_at) throw badRequest('Actual date/time cannot be before the job card was raised');
  if (!can(user.role, 'request.manage') && (toMs(now)! - toMs(at)!) > 48 * 3600000) {
    throw badRequest('Only coordinators can back-date an update by more than 48 hours');
  }
  return at;
}

function engineerExists(id: number | null): number | null {
  if (id === null) return null;
  if (!get('SELECT 1 FROM engineers WHERE id = ? AND active = 1', [id])) throw badRequest('Engineer not found or inactive');
  return id;
}

function markModified(id: number) {
  run('UPDATE requests SET modified_in_app = 1, updated_at = ? WHERE id = ?', [nowLocal(), id]);
}

export function completeStage(requestId: number, key: StageKey, body: any, user: AuthUser) {
  const r = loadRequest(requestId);
  assertCanView(user, r);
  const def = stageDef(key);
  const stage = loadStage(requestId, key);
  if (!canActOnStage(user, def, r, stage)) throw forbidden(`You cannot update the ${def.name} stage`);
  assertLive(r);
  if (stage.status !== 'active') throw conflict(`${def.name} is not the current stage`);
  const actual = resolveActual(body, r, user);
  const comments = str(body.comments, 4000);
  let engineerId = int(body.engineer_id);
  if (user.role === 'engineer') engineerId = user.engineer_id;

  if (def.requiresEvidence) {
    const n = get<{ n: number }>('SELECT COUNT(*) AS n FROM attachments WHERE request_id = ? AND stage_key = ?', [requestId, key])!.n;
    if (!n) throw badRequest(`Attach completion evidence (photo or document) before completing ${def.name}`);
  }

  tx(() => {
    const now = nowLocal();
    const extra: string[] = [];
    if (key === 'triage') {
      const priority = oneOf(body.priority ?? r.priority, PRIORITIES, 'Priority');
      const flags = {
        requires_ph_discussion: bool(body.requires_ph_discussion),
        requires_material: bool(body.requires_material),
        requires_permission: bool(body.requires_permission),
      };
      if (Object.values(flags).some((v) => v === null)) throw badRequest('Answer whether Project Head discussion, material and permission are required');
      const siteEngineer = engineerExists(int(body.site_engineer_id));
      if (!siteEngineer) throw badRequest('Select the site engineer for the site visit');
      run(
        `UPDATE requests SET priority = ?, requires_ph_discussion = ?, requires_material = ?, requires_permission = ?, site_engineer_id = ? WHERE id = ?`,
        [priority, flags.requires_ph_discussion ? 1 : 0, flags.requires_material ? 1 : 0, flags.requires_permission ? 1 : 0, siteEngineer, requestId],
      );
      run(`UPDATE request_stages SET engineer_id = ? WHERE request_id = ? AND stage_key = 'site_visit'`, [siteEngineer, requestId]);
      for (const d of stageDefs().filter((x) => x.flag)) {
        const required = flags[d.flag!];
        run(
          `UPDATE request_stages SET status = ?, comments = ?, updated_by = ?, updated_at = ? WHERE request_id = ? AND stage_key = ? AND status IN ('pending','skipped')`,
          [required ? 'pending' : 'skipped', required ? null : 'Not required (decided at triage)', user.id, now, requestId, d.key],
        );
      }
      extra.push(`priority ${priority}`, ...Object.entries(flags).filter(([, v]) => v).map(([k]) => k.replace('requires_', '').replace('_', ' ') + ' required'));
      engineerId = null;
    }
    if (key === 'engineer_assigned') {
      const eng = engineerExists(int(body.engineer_id) ?? r.assigned_engineer_id);
      if (!eng) throw badRequest('Select the engineer who will carry out the work');
      engineerId = eng;
      run('UPDATE requests SET assigned_engineer_id = ? WHERE id = ?', [eng, requestId]);
      run(`UPDATE request_stages SET engineer_id = ? WHERE request_id = ? AND stage_key IN ('work_started','work_completed') AND status IN ('pending','active')`, [eng, requestId]);
      const name = get('SELECT name FROM engineers WHERE id = ?', [eng])?.name;
      extra.push(`assigned to ${name}`);
    }
    if (key === 'site_visit' && engineerId === null) engineerId = r.site_engineer_id ?? null;
    if ((key === 'work_started' || key === 'work_completed') && engineerId === null) engineerId = r.assigned_engineer_id ?? null;
    if (key === 'verification') {
      run('UPDATE requests SET verified_by_name = ? WHERE id = ?', [str(body.verified_by_name, 120) ?? user.name, requestId]);
    }
    if (key === 'closed') {
      const category = requiredStr(body.closure_category, 'Closure category', 80);
      if (!get('SELECT 1 FROM closure_categories WHERE name = ? AND active = 1', [category])) throw badRequest('Unknown closure category');
      run('UPDATE requests SET closure_category = ?, closure_note = COALESCE(?, closure_note) WHERE id = ?', [category, str(body.closure_note, 2000), requestId]);
      extra.push(category);
    }
    engineerExists(engineerId);

    run(
      `UPDATE request_stages SET status = 'completed', actual_at = ?, delay_minutes = ?, responsible_user_id = ?, responsible_name = ?,
         engineer_id = COALESCE(?, engineer_id), decision = ?, comments = ?, source = 'ui', updated_by = ?, updated_at = ?
       WHERE id = ?`,
      [actual, diffMinutes(actual, stage.planned_at), user.id, user.name, engineerId, def.decision ? 'approved' : null,
        comments ?? stage.comments, user.id, now, stage.id],
    );
    markModified(requestId);
    const verb = def.decision ? 'approved' : 'completed';
    logEvent(requestId, 'stage_completed', `${def.name} ${verb}${extra.length ? ` — ${extra.join(', ')}` : ''}${comments ? `: ${comments}` : ''}`, {
      stageKey: key, user, data: { actual_at: actual, planned_at: stage.planned_at },
    });
    refreshRequestState(requestId);
  });
}

export function skipStage(requestId: number, key: StageKey, body: any, user: AuthUser) {
  const r = loadRequest(requestId);
  const def = stageDef(key);
  const stage = loadStage(requestId, key);
  if (!def.optional) throw badRequest(`${def.name} is mandatory and cannot be skipped`);
  if (!canActOnStage(user, def, r, stage) && !can(user.role, 'request.manage')) throw forbidden();
  assertLive(r);
  if (!['active', 'pending'].includes(stage.status)) throw conflict(`${def.name} cannot be skipped in its current state`);
  const reason = requiredStr(body.reason, 'Reason', 1000);
  tx(() => {
    run(`UPDATE request_stages SET status = 'skipped', comments = ?, responsible_user_id = ?, responsible_name = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      [`Skipped: ${reason}`, user.id, user.name, user.id, nowLocal(), stage.id]);
    if (def.flag) run(`UPDATE requests SET ${def.flag} = 0 WHERE id = ?`, [requestId]);
    markModified(requestId);
    logEvent(requestId, 'stage_skipped', `${def.name} skipped: ${reason}`, { stageKey: key, user });
    refreshRequestState(requestId);
  });
}

export function decideStage(requestId: number, key: StageKey, body: any, user: AuthUser) {
  const def = stageDef(key);
  if (!def.decision) throw badRequest(`${def.name} does not take an approval decision`);
  const decision = oneOf(body.decision, ['approved', 'rejected'] as const, 'Decision');
  if (decision === 'approved') return completeStage(requestId, key, body, user);

  const r = loadRequest(requestId);
  const stage = loadStage(requestId, key);
  if (!canActOnStage(user, def, r, stage)) throw forbidden(`You cannot decide on ${def.name}`);
  assertLive(r);
  if (stage.status !== 'active') throw conflict(`${def.name} is not the current stage`);
  const reason = requiredStr(body.comments, 'Reason for rejection', 2000);
  tx(() => {
    const now = nowLocal();
    if (key === 'verification') {
      // Verification failure sends the job back to the engineer for rework.
      reworkFromCompletion(requestId, user, `Verification failed: ${reason}`);
      return;
    }
    if (key === 'triage') {
      // Request not approved by the coordinator: close it out as rejected (reversible via Reopen).
      run(`UPDATE request_stages SET status = 'rejected', decision = 'rejected', actual_at = ?, comments = ?, responsible_user_id = ?, responsible_name = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
        [now, reason, user.id, user.name, user.id, now, stage.id]);
      run(`UPDATE requests SET cancelled_at = ?, cancel_reason = ?, closure_category = 'Rejected' WHERE id = ?`, [now, `Not approved at triage: ${reason}`, requestId]);
      markModified(requestId);
      logEvent(requestId, 'stage_rejected', `Job card not approved: ${reason}`, { stageKey: key, user });
      refreshRequestState(requestId);
      return;
    }
    run(`UPDATE request_stages SET status = 'rejected', decision = 'rejected', comments = ?, responsible_user_id = ?, responsible_name = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      [reason, user.id, user.name, user.id, now, stage.id]);
    run('UPDATE requests SET held_at = ?, hold_reason = ? WHERE id = ?', [now, `${def.name} rejected: ${reason}`, requestId]);
    markModified(requestId);
    logEvent(requestId, 'stage_rejected', `${def.name} rejected: ${reason}`, { stageKey: key, user });
    refreshRequestState(requestId);
  });
}

/** Return the job to Work Completed (active) and reset verification / closure. */
function reworkFromCompletion(requestId: number, user: AuthUser, message: string) {
  const now = nowLocal();
  const planned = formatMs(addWorkingDays(toMs(now)!, 1, WEEKLY_OFF));
  run(`UPDATE request_stages SET status = 'pending', actual_at = NULL, delay_minutes = NULL, decision = NULL, planned_at = NULL, updated_by = ?, updated_at = ?
       WHERE request_id = ? AND stage_key IN ('verification','closed')`, [user.id, now, requestId]);
  run(`UPDATE request_stages SET status = 'active', actual_at = NULL, delay_minutes = NULL, planned_at = ?, comments = ?, updated_by = ?, updated_at = ?
       WHERE request_id = ? AND stage_key = 'work_completed'`, [planned, message, user.id, now, requestId]);
  run('UPDATE requests SET closure_category = NULL, verified_by_name = NULL WHERE id = ?', [requestId]);
  markModified(requestId);
  logEvent(requestId, 'reopen', message, { stageKey: 'work_completed', user });
  refreshRequestState(requestId);
}

const STAGE_STATUSES = ['pending', 'active', 'completed', 'skipped', 'rejected'] as const;

/** Admin correction of any stage (e.g. fixing imported history). */
export function editStage(requestId: number, key: StageKey, body: any, user: AuthUser) {
  if (!can(user.role, 'stage.edit_history')) throw forbidden();
  loadRequest(requestId);
  const def = stageDef(key);
  const stage = loadStage(requestId, key);
  const planned = body.planned_at === undefined ? stage.planned_at : normalizeLocal(body.planned_at);
  const actual = body.actual_at === undefined ? stage.actual_at : normalizeLocal(body.actual_at);
  const status = body.status === undefined ? stage.status : oneOf(body.status, STAGE_STATUSES, 'Status');
  if (status === 'completed' && !actual) throw badRequest('A completed stage needs an actual date/time');
  if (actual && actual > nowLocal()) throw badRequest('Actual date/time cannot be in the future');
  const engineerId = body.engineer_id === undefined ? stage.engineer_id : engineerExists(int(body.engineer_id));
  const comments = body.comments === undefined ? stage.comments : str(body.comments, 4000);
  const note = requiredStr(body.reason, 'Reason for correction', 1000);
  tx(() => {
    if (status === 'active') {
      run(`UPDATE request_stages SET status = 'pending' WHERE request_id = ? AND status = 'active' AND id <> ?`, [requestId, stage.id]);
    }
    run(
      `UPDATE request_stages SET status = ?, planned_at = ?, actual_at = ?, delay_minutes = ?, engineer_id = ?, comments = ?,
         planned_inferred = CASE WHEN ? THEN 0 ELSE planned_inferred END, actual_inferred = CASE WHEN ? THEN 0 ELSE actual_inferred END,
         updated_by = ?, updated_at = ? WHERE id = ?`,
      [status, planned, status === 'completed' ? actual : null, status === 'completed' ? diffMinutes(actual, planned) : null, engineerId, comments,
        planned !== stage.planned_at ? 1 : 0, actual !== stage.actual_at ? 1 : 0, user.id, nowLocal(), stage.id],
    );
    markModified(requestId);
    logEvent(requestId, 'stage_edited', `${def.name} corrected: ${note}`, {
      stageKey: key, user,
      data: { before: { status: stage.status, planned_at: stage.planned_at, actual_at: stage.actual_at }, after: { status, planned_at: planned, actual_at: actual } },
    });
    refreshRequestState(requestId);
  });
}

function requireManage(user: AuthUser) {
  if (!can(user.role, 'request.manage')) throw forbidden();
}

export function holdRequest(requestId: number, body: any, user: AuthUser) {
  requireManage(user);
  const r = loadRequest(requestId);
  assertLive(r);
  const reason = requiredStr(body.reason, 'Reason', 1000);
  tx(() => {
    run('UPDATE requests SET held_at = ?, hold_reason = ? WHERE id = ?', [nowLocal(), reason, requestId]);
    markModified(requestId);
    logEvent(requestId, 'hold', `Put on hold: ${reason}`, { user });
    refreshRequestState(requestId);
  });
}

export function resumeRequest(requestId: number, body: any, user: AuthUser) {
  requireManage(user);
  const r = loadRequest(requestId);
  if (!r.held_at) throw conflict('Job card is not on hold');
  tx(() => {
    run(`UPDATE request_stages SET status = 'active', decision = NULL WHERE request_id = ? AND status = 'rejected'`, [requestId]);
    run('UPDATE requests SET held_at = NULL, hold_reason = NULL WHERE id = ?', [requestId]);
    markModified(requestId);
    logEvent(requestId, 'resume', `Resumed${str(body.comments) ? `: ${str(body.comments)}` : ''}`, { user });
    refreshRequestState(requestId);
  });
}

export function cancelRequest(requestId: number, body: any, user: AuthUser) {
  requireManage(user);
  const r = loadRequest(requestId);
  if (r.cancelled_at) throw conflict('Job card is already cancelled');
  if (r.status === 'closed') throw conflict('Closed job cards cannot be cancelled');
  const reason = requiredStr(body.reason, 'Reason', 1000);
  tx(() => {
    run('UPDATE requests SET cancelled_at = ?, cancel_reason = ?, held_at = NULL, hold_reason = NULL WHERE id = ?', [nowLocal(), reason, requestId]);
    markModified(requestId);
    logEvent(requestId, 'cancel', `Cancelled: ${reason}`, { user });
    refreshRequestState(requestId);
  });
}

export function reopenRequest(requestId: number, body: any, user: AuthUser) {
  requireManage(user);
  const r = loadRequest(requestId);
  const reason = requiredStr(body.reason, 'Reason', 1000);
  tx(() => {
    if (r.cancelled_at) {
      run(`UPDATE requests SET cancelled_at = NULL, cancel_reason = NULL, closure_category = CASE WHEN closure_category = 'Rejected' THEN NULL ELSE closure_category END WHERE id = ?`, [requestId]);
      run(`UPDATE request_stages SET status = 'active', decision = NULL, actual_at = NULL WHERE request_id = ? AND status = 'rejected'`, [requestId]);
      markModified(requestId);
      logEvent(requestId, 'reopen', `Reinstated: ${reason}`, { user });
      refreshRequestState(requestId);
      return;
    }
    if (r.status !== 'closed' && r.status !== 'completed') throw conflict('Only closed, completed or cancelled job cards can be reopened');
    reworkFromCompletion(requestId, user, `Reopened for rework: ${reason}`);
  });
}

export function assignEngineers(requestId: number, body: any, user: AuthUser) {
  requireManage(user);
  const r = loadRequest(requestId);
  if (r.cancelled_at || r.status === 'closed') throw conflict('Job card is not open');
  const changes: string[] = [];
  tx(() => {
    if (body.site_engineer_id !== undefined) {
      const id = engineerExists(int(body.site_engineer_id));
      run('UPDATE requests SET site_engineer_id = ? WHERE id = ?', [id, requestId]);
      run(`UPDATE request_stages SET engineer_id = ? WHERE request_id = ? AND stage_key = 'site_visit' AND status IN ('pending','active')`, [id, requestId]);
      changes.push(`site engineer → ${id ? get('SELECT name FROM engineers WHERE id = ?', [id])?.name : 'none'}`);
    }
    if (body.assigned_engineer_id !== undefined) {
      const id = engineerExists(int(body.assigned_engineer_id));
      run('UPDATE requests SET assigned_engineer_id = ? WHERE id = ?', [id, requestId]);
      run(`UPDATE request_stages SET engineer_id = ? WHERE request_id = ? AND stage_key IN ('work_started','work_completed') AND status IN ('pending','active')`, [id, requestId]);
      changes.push(`work engineer → ${id ? get('SELECT name FROM engineers WHERE id = ?', [id])?.name : 'none'}`);
    }
    if (!changes.length) throw badRequest('Nothing to assign');
    markModified(requestId);
    logEvent(requestId, 'assigned', `Reassigned: ${changes.join('; ')}`, { user });
  });
}

export function addComment(requestId: number, body: any, user: AuthUser) {
  const r = loadRequest(requestId);
  assertCanView(user, r);
  if (!can(user.role, 'request.comment')) throw forbidden();
  const text = requiredStr(body.comment, 'Comment', 4000);
  const stageKey = body.stage_key ? stageDef(body.stage_key).key : null;
  logEvent(requestId, 'comment', text, { stageKey, user });
}

export function listStageRows(requestId: number) {
  return all('SELECT stage_key, status FROM request_stages WHERE request_id = ? ORDER BY seq', [requestId]);
}
