import type { AuthUser } from '../auth/auth.ts';
import { col, nextId } from '../db/mongo.ts';
import { nowLocal } from '../utils/dates.ts';

export type EventType =
  | 'created' | 'imported' | 'stage_completed' | 'stage_skipped' | 'stage_rejected' | 'stage_edited'
  | 'comment' | 'attachment' | 'assigned' | 'hold' | 'resume' | 'cancel' | 'reopen' | 'edited';

export interface EventOpts { stageKey?: string | null; data?: unknown; user?: AuthUser | null; userName?: string; at?: string }

/** Build an activity-log document (used directly for bulk inserts by the importer). */
export function eventDoc(id: number, requestId: number, type: EventType, message: string, opts: EventOpts = {}) {
  return {
    _id: id,
    request_id: requestId,
    stage_key: opts.stageKey ?? null,
    type,
    message,
    data: opts.data ?? null,
    user_id: opts.user?.id ?? null,
    user_name: opts.user?.name ?? opts.userName ?? 'System',
    created_at: opts.at ?? nowLocal(),
  };
}

export async function logEvent(requestId: number, type: EventType, message: string, opts: EventOpts = {}) {
  await col.events().insertOne(eventDoc(await nextId('request_events'), requestId, type, message, opts));
}
