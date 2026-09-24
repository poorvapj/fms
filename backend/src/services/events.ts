import type { AuthUser } from '../auth/auth.ts';
import { run } from '../db/db.ts';
import { nowLocal } from '../utils/dates.ts';

export type EventType =
  | 'created' | 'imported' | 'stage_completed' | 'stage_skipped' | 'stage_rejected' | 'stage_edited'
  | 'comment' | 'attachment' | 'assigned' | 'hold' | 'resume' | 'cancel' | 'reopen' | 'edited';

export function logEvent(
  requestId: number,
  type: EventType,
  message: string,
  opts: { stageKey?: string | null; data?: unknown; user?: AuthUser | null; userName?: string; at?: string } = {},
) {
  run(
    `INSERT INTO request_events (request_id, stage_key, type, message, data, user_id, user_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      requestId,
      opts.stageKey ?? null,
      type,
      message,
      opts.data === undefined ? null : JSON.stringify(opts.data),
      opts.user?.id ?? null,
      opts.user?.name ?? opts.userName ?? 'System',
      opts.at ?? nowLocal(),
    ],
  );
}
