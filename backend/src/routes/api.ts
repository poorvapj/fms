import { Router, type Request } from 'express';
import { login, logout, requireAuth, requirePermission, userPermissions } from '../auth/auth.ts';
import { config } from '../config.ts';
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
import { badRequest, notFound, toCsv } from '../utils/http.ts';
import { evidenceUpload, importUpload } from './uploads.ts';

export const api = Router();

const id = (req: Request, name = 'id') => {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};
const clientIp = (req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown';
const files = (req: Request) => ((req.files as Express.Multer.File[] | undefined) ?? []);

// ---------------------------------------------------------------- public (no login)
api.get('/public/form-options', async (_req, res) => { res.json(await publicFormOptions()); });
api.get('/public/env', (_req, res) => { res.json({ env: config.env }); });
api.post('/public/requests', evidenceUpload.array('images', 10), async (req, res) => {
  res.status(201).json(await submitPublicRequest(req.body ?? {}, files(req), clientIp(req)));
});
api.get('/public/track/:token', async (req, res) => { res.json(await trackPublicRequest(String(req.params.token))); });

// ---------------------------------------------------------------- auth
api.post('/auth/login', async (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (!username || !password) throw badRequest('Email / username and password are required');
  const user = await login(username, password, clientIp(req), res);
  res.json({ user, permissions: userPermissions(user.role) });
});
api.post('/auth/logout', (_req, res) => { logout(res); res.json({ ok: true }); });

api.use(requireAuth);

api.get('/auth/me', (req, res) => { res.json({ user: req.user, permissions: userPermissions(req.user!.role) }); });
api.post('/auth/change-password', async (req, res) => {
  await changeOwnPassword(req.user!, req.body?.current_password, req.body?.new_password);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- reference data
api.get('/meta', async (_req, res) => {
  const [properties, categories, engineers, closure] = await Promise.all([
    listMaster('properties'), listMaster('categories'), listMaster('engineers'), listClosureCategories(),
  ]);
  res.json({
    env: config.env,
    statuses: REQUEST_STATUSES,
    priorities: PRIORITIES,
    work_types: WORK_TYPES,
    roles: ROLES.map((r) => ({ key: r, label: ROLE_LABELS[r] })),
    stages: publicStageDefs(),
    reports: REPORTS,
    properties, categories, engineers,
    closure_categories: closure.filter((c) => c?.active),
  });
});

// ---------------------------------------------------------------- dashboard & queues
api.get('/dashboard', requirePermission('dashboard.view'), async (req, res) => { res.json(await dashboard(req.query, req.user!)); });
api.get('/my-jobs', async (req, res) => { res.json(await myJobs(req.query, req.user!)); });
api.get('/workflow/stages', (_req, res) => { res.json(publicStageDefs()); });
api.patch('/workflow/stages/:key', requirePermission('masters.manage'), async (req, res) => {
  await updateStageDef(stageDef(String(req.params.key)).key, req.body ?? {});
  res.json(publicStageDefs());
});
api.get('/coordinator/queue', requirePermission('request.manage'), async (req, res) => { res.json(await coordinatorQueue(req.query, req.user!)); });

// ---------------------------------------------------------------- job cards (/requests)
api.get('/requests', async (req, res) => { res.json(await listRequests(req.query, req.user!)); });
api.get('/requests/export.csv', async (req, res) => {
  const rows = await exportRequests(req.query, req.user!);
  const cols = [
    { key: 'request_no', label: 'Job Card' }, { key: 'requested_at', label: 'Raised' }, { key: 'property_name', label: 'Property' },
    { key: 'property_no', label: 'Property No.' }, { key: 'category_name', label: 'Category' }, { key: 'title', label: 'Title' },
    { key: 'priority', label: 'Priority' }, { key: 'status', label: 'Status' }, { key: 'current_stage_name', label: 'Current Stage' },
    { key: 'current_stage_planned_at', label: 'Stage Due' }, { key: 'is_overdue', label: 'Overdue' }, { key: 'engineer_name', label: 'Engineer' },
    { key: 'site_engineer_name', label: 'Site Engineer' }, { key: 'target_date', label: 'Target Date' }, { key: 'completed_at', label: 'Completed' },
    { key: 'source', label: 'Source' },
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="job-cards.csv"');
  res.send(toCsv(cols, rows.map((r) => ({ ...r, is_overdue: r.is_overdue ? 'Yes' : '' }))));
});
api.post('/requests', requirePermission('request.create'), evidenceUpload.array('images', 10), async (req, res) => {
  res.status(201).json(await createRequest(req.body ?? {}, req.user!, files(req)));
});
api.get('/requests/:id', async (req, res) => { res.json(await getRequestDetail(id(req), req.user!)); });
api.patch('/requests/:id', async (req, res) => {
  await updateRequest(id(req), req.body ?? {}, req.user!);
  res.json(await getRequestDetail(id(req), req.user!));
});

const stageKey = (req: Request) => stageDef(String(req.params.key)).key as StageKey;
const stageRoutes = { complete: completeStage, skip: skipStage, decision: decideStage } as const;
for (const [name, fn] of Object.entries(stageRoutes)) {
  api.post(`/requests/:id/stages/:key/${name}`, async (req, res) => {
    await fn(id(req), stageKey(req), req.body ?? {}, req.user!);
    res.json(await getRequestDetail(id(req), req.user!));
  });
}
api.patch('/requests/:id/stages/:key', async (req, res) => {
  await editStage(id(req), stageKey(req), req.body ?? {}, req.user!);
  res.json(await getRequestDetail(id(req), req.user!));
});

const actions = { hold: holdRequest, resume: resumeRequest, cancel: cancelRequest, reopen: reopenRequest, assign: assignEngineers, comments: addComment } as const;
for (const [name, fn] of Object.entries(actions)) {
  api.post(`/requests/:id/${name}`, async (req, res) => {
    await fn(id(req), req.body ?? {}, req.user!);
    res.json(await getRequestDetail(id(req), req.user!));
  });
}
api.post('/requests/:id/attachments', evidenceUpload.single('file'), async (req, res) => {
  await addAttachment(id(req), { stage_key: req.body?.stage_key, url: req.body?.url, caption: req.body?.caption, file: req.file }, req.user!);
  res.status(201).json(await getRequestDetail(id(req), req.user!));
});
api.get('/attachments/:id/file', async (req, res, next) => {
  const f = await getAttachmentFile(id(req), req.user!);
  res.setHeader('Content-Type', f.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.name)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  f.stream.on('error', () => (res.headersSent ? res.end() : next(notFound('File')))).pipe(res);
});
api.delete('/attachments/:id', async (req, res) => { await deleteAttachment(id(req), req.user!); res.json({ ok: true }); });

// ---------------------------------------------------------------- masters
api.get('/masters/:kind', async (req, res) => {
  const kind = String(req.params.kind);
  if (kind === 'closure-categories') return void res.json(await listClosureCategories());
  if (!isMasterKind(kind)) throw notFound();
  res.json(await listMaster(kind, { includeInactive: req.query.all === '1' }));
});
api.post('/masters/:kind', requirePermission('masters.manage'), async (req, res) => {
  const kind = String(req.params.kind);
  if (kind === 'closure-categories') { await saveClosureCategory(req.body ?? {}); return void res.status(201).json(await listClosureCategories()); }
  if (!isMasterKind(kind)) throw notFound();
  res.status(201).json(await createMaster(kind, req.body ?? {}));
});
api.patch('/masters/:kind/:id', requirePermission('masters.manage'), async (req, res) => {
  const kind = String(req.params.kind);
  if (kind === 'closure-categories') { await saveClosureCategory(req.body ?? {}, id(req)); return void res.json(await listClosureCategories()); }
  if (!isMasterKind(kind)) throw notFound();
  res.json(await updateMaster(kind, id(req), req.body ?? {}));
});
api.post('/masters/:kind/:id/merge', requirePermission('masters.manage'), async (req, res) => {
  const kind = String(req.params.kind);
  if (!isMasterKind(kind)) throw notFound();
  res.json(await mergeMaster(kind, id(req), req.body ?? {}));
});

// ---------------------------------------------------------------- users
api.get('/users', requirePermission('users.manage'), async (_req, res) => { res.json(await listUsers()); });
api.post('/users', requirePermission('users.manage'), async (req, res) => { res.status(201).json(await createUser(req.body ?? {})); });
api.patch('/users/:id', requirePermission('users.manage'), async (req, res) => { await updateUser(id(req), req.body ?? {}, req.user!); res.json({ ok: true }); });

// ---------------------------------------------------------------- reports
api.get('/reports/:key', requirePermission('reports.view'), async (req, res) => {
  const report = await runReport(String(req.params.key), req.query, req.user!);
  if (req.query.format !== 'csv') return void res.json(report);
  const csv = report.sections.map((s) => (report.sections.length > 1 ? `${s.title}\r\n` : '') + toCsv(s.columns, s.rows).replace(/^﻿/, '')).join('\r\n\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="report-${report.key}.csv"`);
  res.send('﻿' + csv);
});

// ---------------------------------------------------------------- FMS import
api.get('/imports', requirePermission('import.run'), async (_req, res) => { res.json(await listBatches()); });
api.post('/imports/upload', requirePermission('import.run'), importUpload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Choose a file to upload');
  res.status(201).json(await saveUpload(req.file, req.user!));
});
api.get('/imports/uploads/:uploadId', requirePermission('import.run'), async (req, res) => { res.json(await preview(String(req.params.uploadId), req.user!)); });
api.post('/imports/uploads/:uploadId/validate', requirePermission('import.run'), async (req, res) => { res.json(await validateImport(String(req.params.uploadId), req.body ?? {}, req.user!)); });
api.post('/imports/uploads/:uploadId/commit', requirePermission('import.run'), async (req, res) => { res.json(await commitImport(String(req.params.uploadId), req.body ?? {}, req.user!)); });
api.get('/imports/:id', requirePermission('import.run'), async (req, res) => { res.json(await getBatch(id(req), req.query)); });
api.post('/imports/:id/rollback', requirePermission('import.run'), async (req, res) => { res.json(await rollbackBatch(id(req), req.user!)); });
