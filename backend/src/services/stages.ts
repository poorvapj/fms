import type { AuthUser } from '../auth/auth.ts';
import { col, type Doc } from '../db/mongo.ts';
import { can } from '../domain/permissions.ts';
import { PRIORITIES, WEEKLY_OFF, type StageDefinition, type StageKey } from '../domain/workflow.ts';
import { addWorkingDays, diffMinutes, formatMs, normalizeLocal, nowLocal, toMs } from '../utils/dates.ts';
import { badRequest, bool, conflict, forbidden, int, oneOf, requiredStr, str } from '../utils/http.ts';
import { logEvent } from './events.ts';
import { assertCanView, loadRequest } from './requests.ts';
import { stageDef, stageDefs } from './stageDefs.ts';
import { refreshState, saveRequest, stageOf, type RequestDoc, type StageDoc } from './workflowEngine.ts';

/** Whether a user may act on a stage of a job card (role + engineer binding). */
export function canActOnStage(user: AuthUser, def: StageDefinition, r: Doc, stage: StageDoc | null): boolean {
  if (!can(user.role, 'stage.update') || !def.roles.includes(user.role)) return false;
  if (user.role !== 'engineer') return true;
  if (!user.engineer_id) return false;
  if (def.key === 'site_visit') return r.site_engineer_id === user.engineer_id || stage?.engineer_id === user.engineer_id;
  return r.assigned_engineer_id === user.engineer_id || stage?.engineer_id === user.engineer_id;
}

function assertLive(r: Doc) {
  if (r.cancelled_at) throw conflict('Job card is cancelled');
  if (r.status === 'closed') throw conflict('Job card is closed. Reopen it first.');
  if (r.held_at) throw conflict('Job card is on hold. Resume it first.');
}

function resolveActual(body: any, r: Doc, user: AuthUser): string {
  const now = nowLocal();
  if (!body.actual_at) return now;
  const at = normalizeLocal(body.actual_at);
  if (!at) throw badRequest('Invalid actual date/time');
  if (at > now) throw badRequest('Actual date/time cannot be in the future');
  if (at < r.requested_at) throw badRequest('Actual date/time cannot be before the job card was raised');
  if (!can(user.role, 'request.manage') && toMs(now)! - toMs(at)! > 48 * 3600000) {
    throw badRequest('Only coordinators can back-date an update by more than 48 hours');
  }
  return at;
}

async function engineerExists(id: number | null): Promise<number | null> {
  if (id === null) return null;
  if (!(await col.engineers().findOne({ _id: id, active: 1 }, { projection: { _id: 1 } }))) throw badRequest('Engineer not found or inactive');
  return id;
}

async function engineerName(id: number | null) {
  return id === null ? 'none' : ((await col.engineers().findOne({ _id: id }, { projection: { name: 1 } }))?.name ?? 'unknown');
}

export async function completeStage(requestId: number, key: StageKey, body: any, user: AuthUser) {
  const r = await loadRequest(requestId);
  assertCanView(user, r);
  const def = stageDef(key);
  const stage = stageOf(r, key);
  if (!canActOnStage(user, def, r, stage)) throw forbidden(`You cannot update the ${def.name} stage`);
  assertLive(r);
  if (stage.status !== 'active') throw conflict(`${def.name} is not the current stage`);
  const actual = resolveActual(body, r, user);
  const comments = str(body.comments, 4000);
  let engineerId = int(body.engineer_id);
  if (user.role === 'engineer') engineerId = user.engineer_id;

  if (def.requiresEvidence && !(await col.attachments().countDocuments({ request_id: requestId, stage_key: key }))) {
    throw badRequest(`Attach completion evidence (photo or document) before completing ${def.name}`);
  }

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
    const siteEngineer = await engineerExists(int(body.site_engineer_id));
    if (!siteEngineer) throw badRequest('Select the site engineer for the site visit');
    Object.assign(r, { priority, site_engineer_id: siteEngineer, ...Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, v ? 1 : 0])) });
    stageOf(r, 'site_visit').engineer_id = siteEngineer;
    for (const d of stageDefs().filter((x) => x.flag)) {
      const s = stageOf(r, d.key);
      if (s.status !== 'pending' && s.status !== 'skipped') continue;
      const required = flags[d.flag!];
      Object.assign(s, { status: required ? 'pending' : 'skipped', comments: required ? null : 'Not required (decided at triage)', updated_by: user.id, updated_at: now });
    }
    extra.push(`priority ${priority}`, ...Object.entries(flags).filter(([, v]) => v).map(([k]) => k.replace('requires_', '').replace('_', ' ') + ' required'));
    engineerId = null;
  }
  if (key === 'engineer_assigned') {
    const eng = await engineerExists(int(body.engineer_id) ?? r.assigned_engineer_id ?? null);
    if (!eng) throw badRequest('Select the engineer who will carry out the work');
    engineerId = eng;
    r.assigned_engineer_id = eng;
    for (const k of ['work_started', 'work_completed'] as const) {
      const s = stageOf(r, k);
      if (s.status === 'pending' || s.status === 'active') s.engineer_id = eng;
    }
    extra.push(`assigned to ${await engineerName(eng)}`);
  }
  if (key === 'site_visit' && engineerId === null) engineerId = r.site_engineer_id ?? null;
  if ((key === 'work_started' || key === 'work_completed') && engineerId === null) engineerId = r.assigned_engineer_id ?? null;
  if (key === 'verification') r.verified_by_name = str(body.verified_by_name, 120) ?? user.name;
  if (key === 'closed') {
    const category = requiredStr(body.closure_category, 'Closure category', 80);
    if (!(await col.closureCategories().findOne({ name: category, active: 1 }))) throw badRequest('Unknown closure category');
    r.closure_category = category;
    r.closure_note = str(body.closure_note, 2000) ?? r.closure_note ?? null;
    extra.push(category);
  }
  await engineerExists(engineerId);

  Object.assign(stage, {
    status: 'completed', actual_at: actual, delay_minutes: diffMinutes(actual, stage.planned_at), responsible_user_id: user.id,
    responsible_name: user.name, engineer_id: engineerId ?? stage.engineer_id, decision: def.decision ? 'approved' : null,
    comments: comments ?? stage.comments, source: 'ui', updated_by: user.id, updated_at: now,
  });
  refreshState(r);
  await saveRequest(r);
  const verb = def.decision ? 'approved' : 'completed';
  await logEvent(requestId, 'stage_completed', `${def.name} ${verb}${extra.length ? ` — ${extra.join(', ')}` : ''}${comments ? `: ${comments}` : ''}`, {
    stageKey: key, user, data: { actual_at: actual, planned_at: stage.planned_at },
  });
}

export async function skipStage(requestId: number, key: StageKey, body: any, user: AuthUser) {
  const r = await loadRequest(requestId);
  const def = stageDef(key);
  const stage = stageOf(r, key);
  if (!def.optional) throw badRequest(`${def.name} is mandatory and cannot be skipped`);
  if (!canActOnStage(user, def, r, stage) && !can(user.role, 'request.manage')) throw forbidden();
  assertLive(r);
  if (!['active', 'pending'].includes(stage.status)) throw conflict(`${def.name} cannot be skipped in its current state`);
  const reason = requiredStr(body.reason, 'Reason', 1000);
  Object.assign(stage, { status: 'skipped', comments: `Skipped: ${reason}`, responsible_user_id: user.id, responsible_name: user.name, updated_by: user.id, updated_at: nowLocal() });
  if (def.flag) r[def.flag] = 0;
  refreshState(r);
  await saveRequest(r);
  await logEvent(requestId, 'stage_skipped', `${def.name} skipped: ${reason}`, { stageKey: key, user });
}

export async function decideStage(requestId: number, key: StageKey, body: any, user: AuthUser) {
  const def = stageDef(key);
  if (!def.decision) throw badRequest(`${def.name} does not take an approval decision`);
  const decision = oneOf(body.decision, ['approved', 'rejected'] as const, 'Decision');
  if (decision === 'approved') return completeStage(requestId, key, body, user);

  const r = await loadRequest(requestId);
  const stage = stageOf(r, key);
  if (!canActOnStage(user, def, r, stage)) throw forbidden(`You cannot decide on ${def.name}`);
  assertLive(r);
  if (stage.status !== 'active') throw conflict(`${def.name} is not the current stage`);
  const reason = requiredStr(body.comments, 'Reason for rejection', 2000);
  const now = nowLocal();
  if (key === 'verification') {
    // Verification failure sends the job back to the engineer for rework.
    return reworkFromCompletion(r, user, `Verification failed: ${reason}`);
  }
  if (key === 'triage') {
    // Not approved by the coordinator: close it out as rejected (reversible via Reopen).
    Object.assign(stage, { status: 'rejected', decision: 'rejected', actual_at: now, comments: reason, responsible_user_id: user.id, responsible_name: user.name, updated_by: user.id, updated_at: now });
    Object.assign(r, { cancelled_at: now, cancel_reason: `Not approved at triage: ${reason}`, closure_category: 'Rejected' });
    refreshState(r);
    await saveRequest(r);
    await logEvent(requestId, 'stage_rejected', `Job card not approved: ${reason}`, { stageKey: key, user });
    return;
  }
  Object.assign(stage, { status: 'rejected', decision: 'rejected', comments: reason, responsible_user_id: user.id, responsible_name: user.name, updated_by: user.id, updated_at: now });
  Object.assign(r, { held_at: now, hold_reason: `${def.name} rejected: ${reason}` });
  refreshState(r);
  await saveRequest(r);
  await logEvent(requestId, 'stage_rejected', `${def.name} rejected: ${reason}`, { stageKey: key, user });
}

/** Return the job to Work Completed (active) and reset verification / closure. */
async function reworkFromCompletion(r: RequestDoc, user: AuthUser, message: string) {
  const now = nowLocal();
  for (const k of ['verification', 'closed'] as const) {
    Object.assign(stageOf(r, k), { status: 'pending', actual_at: null, delay_minutes: null, decision: null, planned_at: null, updated_by: user.id, updated_at: now });
  }
  Object.assign(stageOf(r, 'work_completed'), {
    status: 'active', actual_at: null, delay_minutes: null, planned_at: formatMs(addWorkingDays(toMs(now)!, 1, WEEKLY_OFF)),
    comments: message, updated_by: user.id, updated_at: now,
  });
  Object.assign(r, { closure_category: null, verified_by_name: null });
  refreshState(r);
  await saveRequest(r);
  await logEvent(r._id, 'reopen', message, { stageKey: 'work_completed', user });
}

const STAGE_STATUSES = ['pending', 'active', 'completed', 'skipped', 'rejected'] as const;

/** Admin correction of any stage (e.g. fixing imported history). */
export async function editStage(requestId: number, key: StageKey, body: any, user: AuthUser) {
  if (!can(user.role, 'stage.edit_history')) throw forbidden();
  const r = await loadRequest(requestId);
  const def = stageDef(key);
  const stage = stageOf(r, key);
  const planned = body.planned_at === undefined ? stage.planned_at : normalizeLocal(body.planned_at);
  const actual = body.actual_at === undefined ? stage.actual_at : normalizeLocal(body.actual_at);
  const status = body.status === undefined ? stage.status : oneOf(body.status, STAGE_STATUSES, 'Status');
  if (status === 'completed' && !actual) throw badRequest('A completed stage needs an actual date/time');
  if (actual && actual > nowLocal()) throw badRequest('Actual date/time cannot be in the future');
  const engineerId = body.engineer_id === undefined ? stage.engineer_id : await engineerExists(int(body.engineer_id));
  const comments = body.comments === undefined ? stage.comments : str(body.comments, 4000);
  const note = requiredStr(body.reason, 'Reason for correction', 1000);
  const before = { status: stage.status, planned_at: stage.planned_at, actual_at: stage.actual_at };
  if (status === 'active') for (const s of r.stages) if (s !== stage && s.status === 'active') s.status = 'pending';
  Object.assign(stage, {
    status, planned_at: planned, actual_at: status === 'completed' ? actual : null,
    delay_minutes: status === 'completed' ? diffMinutes(actual, planned) : null, engineer_id: engineerId, comments,
    planned_inferred: planned !== stage.planned_at ? false : stage.planned_inferred,
    actual_inferred: actual !== stage.actual_at ? false : stage.actual_inferred,
    updated_by: user.id, updated_at: nowLocal(),
  });
  refreshState(r);
  await saveRequest(r);
  await logEvent(requestId, 'stage_edited', `${def.name} corrected: ${note}`, {
    stageKey: key, user, data: { before, after: { status, planned_at: planned, actual_at: actual } },
  });
}

function requireManage(user: AuthUser) {
  if (!can(user.role, 'request.manage')) throw forbidden();
}

export async function holdRequest(requestId: number, body: any, user: AuthUser) {
  requireManage(user);
  const r = await loadRequest(requestId);
  assertLive(r);
  const reason = requiredStr(body.reason, 'Reason', 1000);
  Object.assign(r, { held_at: nowLocal(), hold_reason: reason });
  refreshState(r);
  await saveRequest(r);
  await logEvent(requestId, 'hold', `Put on hold: ${reason}`, { user });
}

export async function resumeRequest(requestId: number, body: any, user: AuthUser) {
  requireManage(user);
  const r = await loadRequest(requestId);
  if (!r.held_at) throw conflict('Job card is not on hold');
  for (const s of r.stages) if (s.status === 'rejected') Object.assign(s, { status: 'active', decision: null });
  Object.assign(r, { held_at: null, hold_reason: null });
  refreshState(r);
  await saveRequest(r);
  await logEvent(requestId, 'resume', `Resumed${str(body.comments) ? `: ${str(body.comments)}` : ''}`, { user });
}

export async function cancelRequest(requestId: number, body: any, user: AuthUser) {
  requireManage(user);
  const r = await loadRequest(requestId);
  if (r.cancelled_at) throw conflict('Job card is already cancelled');
  if (r.status === 'closed') throw conflict('Closed job cards cannot be cancelled');
  const reason = requiredStr(body.reason, 'Reason', 1000);
  Object.assign(r, { cancelled_at: nowLocal(), cancel_reason: reason, held_at: null, hold_reason: null });
  refreshState(r);
  await saveRequest(r);
  await logEvent(requestId, 'cancel', `Cancelled: ${reason}`, { user });
}

export async function reopenRequest(requestId: number, body: any, user: AuthUser) {
  requireManage(user);
  const r = await loadRequest(requestId);
  const reason = requiredStr(body.reason, 'Reason', 1000);
  if (r.cancelled_at) {
    Object.assign(r, { cancelled_at: null, cancel_reason: null, closure_category: r.closure_category === 'Rejected' ? null : r.closure_category });
    for (const s of r.stages) if (s.status === 'rejected') Object.assign(s, { status: 'active', decision: null, actual_at: null });
    refreshState(r);
    await saveRequest(r);
    await logEvent(requestId, 'reopen', `Reinstated: ${reason}`, { user });
    return;
  }
  if (r.status !== 'closed' && r.status !== 'completed') throw conflict('Only closed, completed or cancelled job cards can be reopened');
  await reworkFromCompletion(r, user, `Reopened for rework: ${reason}`);
}

export async function assignEngineers(requestId: number, body: any, user: AuthUser) {
  requireManage(user);
  const r = await loadRequest(requestId);
  if (r.cancelled_at || r.status === 'closed') throw conflict('Job card is not open');
  const changes: string[] = [];
  if (body.site_engineer_id !== undefined) {
    const id = await engineerExists(int(body.site_engineer_id));
    r.site_engineer_id = id;
    const s = stageOf(r, 'site_visit');
    if (s.status === 'pending' || s.status === 'active') s.engineer_id = id;
    changes.push(`site engineer → ${await engineerName(id)}`);
  }
  if (body.assigned_engineer_id !== undefined) {
    const id = await engineerExists(int(body.assigned_engineer_id));
    r.assigned_engineer_id = id;
    for (const k of ['work_started', 'work_completed'] as const) {
      const s = stageOf(r, k);
      if (s.status === 'pending' || s.status === 'active') s.engineer_id = id;
    }
    changes.push(`work engineer → ${await engineerName(id)}`);
  }
  if (!changes.length) throw badRequest('Nothing to assign');
  await saveRequest(r);
  await logEvent(requestId, 'assigned', `Reassigned: ${changes.join('; ')}`, { user });
}

export async function addComment(requestId: number, body: any, user: AuthUser) {
  const r = await loadRequest(requestId);
  assertCanView(user, r);
  if (!can(user.role, 'request.comment')) throw forbidden();
  const text = requiredStr(body.comment, 'Comment', 4000);
  const stageKey = body.stage_key ? stageDef(body.stage_key).key : null;
  await logEvent(requestId, 'comment', text, { stageKey, user });
}
