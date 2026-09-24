import { unlinkSync } from 'node:fs';
import path from 'node:path';
import type { AuthUser } from '../auth/auth.ts';
import { config } from '../config.ts';
import { get, run } from '../db/db.ts';
import { can } from '../domain/permissions.ts';
import { nowLocal } from '../utils/dates.ts';
import { badRequest, forbidden, notFound, str } from '../utils/http.ts';
import { logEvent } from './events.ts';
import { assertCanView, loadRequest } from './requests.ts';
import { stageDef } from './stageDefs.ts';

export const ALLOWED_MIME = /^(image\/(jpeg|png|gif|webp|heic|heif)|application\/pdf|video\/(mp4|quicktime)|application\/vnd\.openxmlformats-officedocument\.(spreadsheetml\.sheet|wordprocessingml\.document))$/;

export function addAttachment(
  requestId: number,
  input: { stage_key?: string; url?: string; caption?: string; file?: Express.Multer.File },
  user: AuthUser,
) {
  const r = loadRequest(requestId);
  try {
    assertCanView(user, r);
    if (!can(user.role, 'request.comment')) throw forbidden();
    const stageKey = input.stage_key ? stageDef(input.stage_key).key : null;
    const caption = str(input.caption, 300);
    const now = nowLocal();
    let id: number;
    if (input.file) {
      id = run(
        `INSERT INTO attachments (request_id, stage_key, kind, stored_name, file_name, mime, size, caption, source, uploaded_by, created_at)
         VALUES (?, ?, 'file', ?, ?, ?, ?, ?, 'ui', ?, ?)`,
        [requestId, stageKey, input.file.filename, input.file.originalname.slice(0, 200), input.file.mimetype, input.file.size, caption, user.id, now],
      ).lastInsertRowid;
    } else {
      const url = str(input.url, 2000);
      if (!url || !/^https?:\/\//i.test(url)) throw badRequest('Provide a file or a valid http(s) link');
      id = run(
        `INSERT INTO attachments (request_id, stage_key, kind, url, caption, source, uploaded_by, created_at) VALUES (?, ?, 'url', ?, ?, 'ui', ?, ?)`,
        [requestId, stageKey, url, caption, user.id, now],
      ).lastInsertRowid;
    }
    run('UPDATE requests SET modified_in_app = 1, updated_at = ? WHERE id = ?', [now, requestId]);
    logEvent(requestId, 'attachment', `Added ${input.file ? `file ${input.file.originalname}` : 'link'}${caption ? ` — ${caption}` : ''}`, { stageKey, user });
    return { id };
  } catch (err) {
    if (input.file) removeStored(input.file.filename);
    throw err;
  }
}

function removeStored(name: string) {
  try { unlinkSync(path.join(config.uploadsDir, path.basename(name))); } catch { /* already gone */ }
}

export function getAttachmentFile(id: number, user: AuthUser) {
  const a = get('SELECT * FROM attachments WHERE id = ?', [id]);
  if (!a || a.kind !== 'file') throw notFound('Attachment');
  assertCanView(user, loadRequest(a.request_id));
  return { path: path.join(config.uploadsDir, path.basename(a.stored_name)), name: a.file_name as string, mime: a.mime as string };
}

export function deleteAttachment(id: number, user: AuthUser) {
  const a = get('SELECT * FROM attachments WHERE id = ?', [id]);
  if (!a) throw notFound('Attachment');
  const r = loadRequest(a.request_id);
  assertCanView(user, r);
  if (!(a.uploaded_by === user.id || can(user.role, 'request.manage'))) throw forbidden();
  if (a.source !== 'ui') throw badRequest('Imported evidence cannot be deleted');
  const stage = a.stage_key ? get('SELECT status FROM request_stages WHERE request_id = ? AND stage_key = ?', [a.request_id, a.stage_key]) : null;
  if (stage?.status === 'completed' && !can(user.role, 'request.manage')) throw badRequest('Evidence of a completed stage cannot be removed');
  run('DELETE FROM attachments WHERE id = ?', [id]);
  if (a.stored_name) removeStored(a.stored_name);
  logEvent(a.request_id, 'attachment', `Removed ${a.file_name ?? 'link'}`, { stageKey: a.stage_key, user });
}
