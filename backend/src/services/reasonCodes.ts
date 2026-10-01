import { col, nextId, withId } from '../db/mongo.ts';
import { badRequest, bool, notFound, oneOf, requiredStr } from '../utils/http.ts';

/**
 * Structured reason codes (admin-editable labels) for hold / cancel / reopen, offered in the UI as
 * a quick-pick dropdown that fills the existing free-text `reason` field. Closure reasons already
 * have a dedicated master (`closure_categories`, see services/masters.ts) so they are NOT
 * duplicated here — the Reasons tab just surfaces that existing list alongside these.
 *
 * IMPORTANT: hold/cancel/reopen endpoints (services/stages.ts holdRequest/cancelRequest/reopenRequest)
 * still accept and store free text verbatim, unchanged. These codes are a convenience, not a
 * validation constraint — picking one just fills the text box before submit.
 */
export const REASON_KINDS = ['hold', 'cancel', 'reopen'] as const;
export type ReasonKind = (typeof REASON_KINDS)[number];

const SEED: Record<ReasonKind, { code: string; label: string }[]> = {
  hold: [
    { code: 'DEPENDENCY_ON_OTHER_WORK', label: 'Dependency on Other Work' },
    { code: 'EXTERNAL_VENDOR', label: 'External Vendor' },
    { code: 'MANAGEMENT_HOLD', label: 'Management Hold' },
    { code: 'SAFETY_RESTRICTION', label: 'Safety Restriction' },
    { code: 'SITE_ACCESS_ISSUE', label: 'Site Access Issue' },
    { code: 'TECHNICAL_CONSTRAINT', label: 'Technical Constraint' },
    { code: 'WAITING_APPROVAL', label: 'Waiting for Approval' },
    { code: 'WAITING_MATERIAL', label: 'Waiting for Material' },
    { code: 'WAITING_REQUESTER', label: 'Waiting for Requester' },
    { code: 'WEATHER', label: 'Weather' },
  ],
  cancel: [
    { code: 'RAISED_IN_ERROR', label: 'Raised in Error' },
    { code: 'REQUESTER_WITHDREW', label: 'Requester Withdrew Request' },
  ],
  reopen: [
    { code: 'ISSUE_RECURRED', label: 'Issue Recurred' },
    { code: 'INCOMPLETE_FIX', label: 'Original Fix Was Incomplete' },
  ],
};

/** Idempotent seed, called from db/seed.ts ensureBaseData(). */
export async function seedReasonCodes() {
  for (const kind of REASON_KINDS) {
    for (const [i, { code, label }] of SEED[kind].entries()) {
      await col.reasonCodes().updateOne(
        { kind, code },
        { $setOnInsert: { _id: await nextId('reason_codes'), kind, code, label, active: 1, sort: i } },
        { upsert: true },
      );
    }
  }
}

export async function listReasonCodes(kind?: string) {
  const filter = kind ? { kind } : {};
  return (await col.reasonCodes().find(filter).sort({ kind: 1, sort: 1 }).toArray()).map(withId);
}

export async function createReasonCode(body: any) {
  const kind = oneOf(body.kind, REASON_KINDS, 'Kind');
  const code = requiredStr(body.code, 'Code', 60).toUpperCase().replace(/\s+/g, '_');
  const label = requiredStr(body.label, 'Label', 120);
  const doc = { _id: await nextId('reason_codes'), kind, code, label, active: 1, sort: 999 };
  await col.reasonCodes().insertOne(doc);
  return withId(doc);
}

export async function updateReasonCode(id: number, body: any) {
  const set: Record<string, unknown> = {};
  if (body.label !== undefined) set.label = requiredStr(body.label, 'Label', 120);
  if (body.active !== undefined) set.active = bool(body.active) ? 1 : 0;
  if (!Object.keys(set).length) throw badRequest('Nothing to update');
  const r = await col.reasonCodes().updateOne({ _id: id }, { $set: set });
  if (!r.matchedCount) throw notFound('Reason code');
}
