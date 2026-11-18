import type { AuthUser } from '../auth/auth.ts';
import { col, nextId } from '../db/mongo.ts';
import { nowLocal } from '../utils/dates.ts';

export type AuditType = 'login' | 'login_failed' | 'user_created' | 'user_updated' | 'password_changed';

export interface AuditOpts { user?: AuthUser | null; userName?: string; data?: unknown }

export async function logAudit(type: AuditType, message: string, opts: AuditOpts = {}) {
  await col.auditLog().insertOne({
    _id: await nextId('audit_log'),
    type,
    message,
    data: opts.data ?? null,
    user_id: opts.user?.id ?? null,
    user_name: opts.user?.name ?? opts.userName ?? 'System',
    created_at: nowLocal(),
  });
}

export async function listAuditLog(limit = 200) {
  const rows = await col.auditLog().find({}).sort({ _id: -1 }).limit(Math.min(limit, 500)).toArray();
  return rows.map(({ _id, ...r }) => ({ id: _id, ...r }));
}
