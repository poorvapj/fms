import { Readable } from 'node:stream';
import { ObjectId } from 'mongodb';
import sharp from 'sharp';
import type { AuthUser } from '../auth/auth.ts';
import { col, files, nextId } from '../db/mongo.ts';
import { can } from '../domain/permissions.ts';
import { nowLocal } from '../utils/dates.ts';
import { badRequest, forbidden, notFound, str } from '../utils/http.ts';
import { logEvent } from './events.ts';
import { assertCanView, loadRequest } from './requests.ts';
import { stageDef } from './stageDefs.ts';

export const ALLOWED_MIME = /^(image\/(jpeg|png|gif|webp|heic|heif)|application\/pdf|video\/(mp4|quicktime)|application\/vnd\.openxmlformats-officedocument\.(spreadsheetml\.sheet|wordprocessingml\.document))$/;

export interface UploadFile { originalname: string; mimetype: string; size: number; buffer: Buffer }

const COMPRESSIBLE_IMAGE = /^image\/(jpeg|png|webp)$/;

/** Downscales + re-encodes a photo to cut bandwidth/storage, without changing its format or
 *  how the rest of the app sees it (still an image, same mimetype, just smaller bytes). Skipped
 *  for anything already small, GIFs (animation would break) and HEIC/HEIF (sharp build-dependent). */
async function compressImage(f: UploadFile): Promise<UploadFile> {
  if (!COMPRESSIBLE_IMAGE.test(f.mimetype) || f.size < 300 * 1024) return f;
  try {
    const img = sharp(f.buffer).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true });
    const buffer = f.mimetype === 'image/png' ? await img.png({ quality: 80, compressionLevel: 9 }).toBuffer()
      : f.mimetype === 'image/webp' ? await img.webp({ quality: 75 }).toBuffer()
      : await img.jpeg({ quality: 75, mozjpeg: true }).toBuffer();
    if (buffer.length >= f.size) return f;
    return { ...f, buffer, size: buffer.length };
  } catch {
    return f; // corrupt/unsupported image data — store the original rather than fail the upload
  }
}

/** Store file bytes in MongoDB (GridFS) — nothing is kept on the server's disk. Photos are
 *  compressed first; `size` in the result reflects what was actually stored. */
export async function storeFile(f: UploadFile): Promise<{ id: ObjectId; size: number }> {
  const stored = await compressImage(f);
  const upload = files().openUploadStream(stored.originalname.slice(0, 200), { metadata: { mime: stored.mimetype } });
  await new Promise<void>((resolve, reject) => {
    Readable.from(stored.buffer).pipe(upload).on('finish', () => resolve()).on('error', reject);
  });
  return { id: upload.id as ObjectId, size: stored.size };
}

export async function removeFiles(ids: (ObjectId | null | undefined)[]) {
  for (const id of ids) {
    if (!id) continue;
    try { await files().delete(id); } catch { /* already gone */ }
  }
}

export async function addAttachment(
  requestId: number,
  input: { stage_key?: string; url?: string; caption?: string; file?: UploadFile; source?: 'ui' | 'comment' },
  user: AuthUser,
) {
  const r = await loadRequest(requestId);
  assertCanView(user, r);
  if (!can(user, 'request.comment')) throw forbidden();
  const stageKey = input.stage_key ? stageDef(input.stage_key).key : null;
  const caption = str(input.caption, 300);
  const now = nowLocal();
  let doc: Record<string, unknown>;
  if (input.file) {
    const stored = await storeFile(input.file);
    doc = {
      kind: 'file', file_id: stored.id, file_name: input.file.originalname.slice(0, 200),
      mime: input.file.mimetype, size: stored.size,
    };
  } else {
    const url = str(input.url, 2000);
    if (!url || !/^https?:\/\//i.test(url)) throw badRequest('Provide a file or a valid http(s) link');
    doc = { kind: 'url', url };
  }
  const id = await nextId('attachments');
  await col.attachments().insertOne({ _id: id, request_id: requestId, stage_key: stageKey, ...doc, caption, source: input.source ?? 'ui', uploaded_by: user.id, created_at: now });
  await col.requests().updateOne({ _id: requestId }, { $set: { modified_in_app: true, updated_at: now } });
  await logEvent(requestId, 'attachment', `Added ${input.file ? `file ${input.file.originalname}` : 'link'}${caption ? ` — ${caption}` : ''}`, { stageKey, user });
  return { id };
}

export async function getAttachmentFile(id: number, user: AuthUser) {
  const a = await col.attachments().findOne({ _id: id });
  if (!a || a.kind !== 'file' || !a.file_id) throw notFound('Attachment');
  assertCanView(user, await loadRequest(a.request_id));
  return { stream: files().openDownloadStream(a.file_id), name: a.file_name as string, mime: a.mime as string };
}

export async function deleteAttachment(id: number, user: AuthUser) {
  const a = await col.attachments().findOne({ _id: id });
  if (!a) throw notFound('Attachment');
  const r = await loadRequest(a.request_id);
  assertCanView(user, r);
  if (!(a.uploaded_by === user.id || can(user, 'request.manage'))) throw forbidden();
  if (a.source === 'fms_import') throw badRequest('Imported evidence cannot be deleted');
  const stage = a.stage_key ? r.stages.find((s) => s.stage_key === a.stage_key) : null;
  if (stage?.status === 'completed' && !can(user, 'request.manage')) throw badRequest('Evidence of a completed stage cannot be removed');
  await col.attachments().deleteOne({ _id: id });
  await removeFiles([a.file_id]);
  await logEvent(a.request_id, 'attachment', `Removed ${a.file_name ?? 'link'}`, { stageKey: a.stage_key, user });
}
