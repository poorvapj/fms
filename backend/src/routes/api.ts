import { existsSync, unlinkSync } from 'node:fs';
import { Router, type Request } from 'express';
import { login, logout, requireAuth, requirePermission, userPermissions } from '../auth/auth.ts';
import { ROLE_LABELS, ROLES } from '../domain/permissions.ts';
import { PRIORITIES, REQUEST_STATUSES, WORK_TYPES, type StageKey } from '../domain/workflow.ts';
import { commitImport, getBatch, listBatches, preview, rollbackBatch, saveUpload, validateImport } from '../import/importService.ts';
import { addAttachment, deleteAttachment, getAttachmentFile } from '../services/attachments.ts';
import { coordinatorQueue, dashboard, myJobs } from '../services/dashboard.ts';
import {
  createMaster, isMasterKind, listClosureCategories, listMaster, mergeMaster, saveClosureCategory, updateMaster,
} from '../services/masters.ts';
import { publicFormOptions, submitPublicRequest, trackPublicRequest } from '../services/publicService.ts';
import { REPORTS, runReport } from '../services/reports.ts';
import { createRequest, exportRequests, getRequestDetail, listRequests, updateRequest } from '../services/requests.ts';
import { publicStageDefs, stageDef, updateStageDef } from '../services/stageDefs.ts';
import {
  addComment, assignEngineers, cancelRequest, completeStage, decideStage, editStage, holdRequest, reopenRequest, resumeRequest, skipStage,
} from '../services/stages.ts';
import { changeOwnPassword, createUser, listUsers, updateUser } from '../services/users.ts';
import { toCsv, badRequest, notFound } from '../utils/http.ts';
import { config } from '../config.ts';
import { evidenceUpload, importUpload } from './uploads.ts';

export const api = Router();

const id = (req: Request, name = 'id') => {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};
const clientIp = (req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown';
const files = (req: Request) => ((req.files as Express.Multer.File[] | undefined) ?? []);
/** Remove uploaded files if the handler fails, so rejected submissions leave nothing on disk. */
function cleanupOnError<T>(req: Request, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    for (const f of files(req)) { try { unlinkSync(f.path); } catch { /* ignore */ } }
    throw err;
  }
}

// ---------------------------------------------------------------- public (no login)
api.get('/public/form-options', (_req, res) => res.json(publicFormOptions()));
api.get('/public/env', (_req, res) => res.json({ env: config.env }));
api.post('/public/requests', evidenceUpload.array('images', 10), (req, res) => {
  res.status(201).json(cleanupOnError(req, () => submitPublicRequest(req.body ?? {}, files(req), clientIp(req))));
});
api.get('/public/track/:token', (req, res) => res.json(trackPublicRequest(String(req.params.token))));

// ---------------------------------------------------------------- auth
api.post('/auth/login', (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (!username || !password) throw badRequest('Username and password are required');
  const user = login(username, password, clientIp(req), res);
  res.json({ user, permissions: userPermissions(user.role) });
});
api.post('/auth/logout', (_req, res) => { logout(res); res.json({ ok: true }); });

api.use(requireAuth);

api.get('/auth/me', (req, res) => res.json({ user: req.user, permissions: userPermissions(req.user!.role) }));
api.post('/auth/change-password', (req, res) => {
  changeOwnPassword(req.user!, req.body?.current_password, req.body?.new_password);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- reference data
api.get('/meta', (_req, res) => {
  res.json({
    env: config.env,
    statuses: REQUEST_STATUSES,
    priorities: PRIORITIES,
    work_types: WORK_TYPES,
    roles: ROLES.map((r) => ({ key: r, label: ROLE_LABELS[r] })),
    stages: publicStageDefs(),
    reports: REPORTS,
    properties: listMaster('properties'),
    categories: listMaster('categories'),
    engineers: listMaster('engineers'),
    closure_categories: listClosureCategories().filter((c) => c.active),
  });
});

// ---------------------------------------------------------------- dashboard & queues
api.get('/dashboard', requirePermission('dashboard.view'), (req, res) => res.json(dashboard(req.query, req.user!)));
api.get('/my-jobs', (req, res) => res.json(myJobs(req.query, req.user!)));
api.get('/workflow/stages', (_req, res) => res.json(publicStageDefs()));
api.patch('/workflow/stages/:key', requirePermission('masters.manage'), (req, res) => {
  updateStageDef(stageDef(String(req.params.key)).key, req.body ?? {});
  res.json(publicStageDefs());
});
api.get('/coordinator/queue', requirePermission('request.manage'), (req, res) => res.json(coordinatorQueue(req.query, req.user!)));

// ---------------------------------------------------------------- requests
api.get('/requests', (req, res) => res.json(listRequests(req.query, req.user!)));
api.get('/requests/export.csv', (req, res) => {
  const rows = exportRequests(req.query, req.user!);
  const cols = [
    { key: 'request_no', label: 'Job Card' }, { key: 'requested_at', label: 'Raised' }, { key: 'property_name', label: 'Property' },
    { key: 'category_name', label: 'Category' }, { key: 'title', label: 'Title' }, { key: 'priority', label: 'Priority' },
    { key: 'status', label: 'Status' }, { key: 'current_stage_name', label: 'Current Stage' }, { key: 'current_stage_planned_at', label: 'Stage Due' },
    { key: 'is_overdue', label: 'Overdue' }, { key: 'engineer_name', label: 'Engineer' }, { key: 'site_engineer_name', label: 'Site Engineer' },
    { key: 'target_date', label: 'Target Date' }, { key: 'completed_at', label: 'Completed' }, { key: 'source', label: 'Source' },
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="job-cards.csv"');
  res.send(toCsv(cols, rows.map((r) => ({ ...r, is_overdue: r.is_overdue ? 'Yes' : '' }))));
});
api.post('/requests', requirePermission('request.create'), evidenceUpload.array('images', 10), (req, res) => {
  res.status(201).json(cleanupOnError(req, () => createRequest(req.body ?? {}, req.user!, files(req))));
});
api.get('/requests/:id', (req, res) => res.json(getRequestDetail(id(req), req.user!)));
api.patch('/requests/:id', (req, res) => { updateRequest(id(req), req.body ?? {}, req.user!); res.json(getRequestDetail(id(req), req.user!)); });

const stageKey = (req: Request) => stageDef(String(req.params.key)).key as StageKey;
api.post('/requests/:id/stages/:key/complete', (req, res) => { completeStage(id(req), stageKey(req), req.body ?? {}, req.user!); res.json(getRequestDetail(id(req), req.user!)); });
api.post('/requests/:id/stages/:key/skip', (req, res) => { skipStage(id(req), stageKey(req), req.body ?? {}, req.user!); res.json(getRequestDetail(id(req), req.user!)); });
api.post('/requests/:id/stages/:key/decision', (req, res) => { decideStage(id(req), stageKey(req), req.body ?? {}, req.user!); res.json(getRequestDetail(id(req), req.user!)); });
api.patch('/requests/:id/stages/:key', (req, res) => { editStage(id(req), stageKey(req), req.body ?? {}, req.user!); res.json(getRequestDetail(id(req), req.user!)); });

const actions = { hold: holdRequest, resume: resumeRequest, cancel: cancelRequest, reopen: reopenRequest, assign: assignEngineers } as const;
for (const [name, fn] of Object.entries(actions)) {
  api.post(`/requests/:id/${name}`, (req, res) => { fn(id(req), req.body ?? {}, req.user!); res.json(getRequestDetail(id(req), req.user!)); });
}
api.post('/requests/:id/comments', (req, res) => { addComment(id(req), req.body ?? {}, req.user!); res.json(getRequestDetail(id(req), req.user!)); });
api.post('/requests/:id/attachments', evidenceUpload.single('file'), (req, res) => {
  addAttachment(id(req), { stage_key: req.body?.stage_key, url: req.body?.url, caption: req.body?.caption, file: req.file }, req.user!);
  res.status(201).json(getRequestDetail(id(req), req.user!));
});
api.get('/attachments/:id/file', (req, res) => {
  const f = getAttachmentFile(id(req), req.user!);
  if (!existsSync(f.path)) throw notFound('File');
  res.setHeader('Content-Type', f.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.name)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(f.path);
});
api.delete('/attachments/:id', (req, res) => { deleteAttachment(id(req), req.user!); res.json({ ok: true }); });

// ---------------------------------------------------------------- masters
api.get('/masters/:kind', (req, res) => {
  const kind = String(req.params.kind);
  if (kind === 'closure-categories') return res.json(listClosureCategories());
  if (!isMasterKind(kind)) throw notFound();
  res.json(listMaster(kind, { includeInactive: req.query.all === '1' }));
});
api.post('/masters/:kind', requirePermission('masters.manage'), (req, res) => {
  const kind = String(req.params.kind);
  if (kind === 'closure-categories') { saveClosureCategory(req.body ?? {}); return res.status(201).json(listClosureCategories()); }
  if (!isMasterKind(kind)) throw notFound();
  res.status(201).json(createMaster(kind, req.body ?? {}));
});
api.patch('/masters/:kind/:id', requirePermission('masters.manage'), (req, res) => {
  const kind = String(req.params.kind);
  if (kind === 'closure-categories') { saveClosureCategory(req.body ?? {}, id(req)); return res.json(listClosureCategories()); }
  if (!isMasterKind(kind)) throw notFound();
  res.json(updateMaster(kind, id(req), req.body ?? {}));
});
api.post('/masters/:kind/:id/merge', requirePermission('masters.manage'), (req, res) => {
  const kind = String(req.params.kind);
  if (!isMasterKind(kind)) throw notFound();
  res.json(mergeMaster(kind, id(req), req.body ?? {}));
});

// ---------------------------------------------------------------- users
api.get('/users', requirePermission('users.manage'), (_req, res) => res.json(listUsers()));
api.post('/users', requirePermission('users.manage'), (req, res) => res.status(201).json(createUser(req.body ?? {})));
api.patch('/users/:id', requirePermission('users.manage'), (req, res) => { updateUser(id(req), req.body ?? {}, req.user!); res.json({ ok: true }); });

// ---------------------------------------------------------------- reports
api.get('/reports/:key', requirePermission('reports.view'), (req, res) => {
  const report = runReport(String(req.params.key), req.query, req.user!);
  if (req.query.format !== 'csv') return res.json(report);
  const csv = report.sections.map((s) => (report.sections.length > 1 ? `${s.title}\r\n` : '') + toCsv(s.columns, s.rows).replace(/^﻿/, '')).join('\r\n\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="report-${report.key}.csv"`);
  res.send('﻿' + csv);
});

// ---------------------------------------------------------------- FMS import
api.get('/imports', requirePermission('import.run'), (_req, res) => res.json(listBatches()));
api.post('/imports/upload', requirePermission('import.run'), importUpload.single('file'), (req, res) => {
  if (!req.file) throw badRequest('Choose a file to upload');
  res.status(201).json(saveUpload(req.file, req.user!));
});
api.get('/imports/uploads/:uploadId', requirePermission('import.run'), (req, res) => res.json(preview(String(req.params.uploadId), req.user!)));
api.post('/imports/uploads/:uploadId/validate', requirePermission('import.run'), (req, res) => res.json(validateImport(String(req.params.uploadId), req.body ?? {}, req.user!)));
api.post('/imports/uploads/:uploadId/commit', requirePermission('import.run'), (req, res) => res.json(commitImport(String(req.params.uploadId), req.body ?? {}, req.user!)));
api.get('/imports/:id', requirePermission('import.run'), (req, res) => res.json(getBatch(id(req), req.query)));
api.post('/imports/:id/rollback', requirePermission('import.run'), (req, res) => res.json(rollbackBatch(id(req), req.user!)));
