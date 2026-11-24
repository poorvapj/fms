import { Router, type Request } from 'express';
import { login, logout, requireAuth, requirePermission } from '../auth/auth.ts';
import { config } from '../config.ts';
import { col } from '../db/mongo.ts';
import { ROLE_LABELS, ROLES } from '../domain/permissions.ts';
import { PRIORITIES, REQUEST_STATUSES, WORK_TYPES, type StageKey } from '../domain/workflow.ts';
import { commitImport, getBatch, listBatches, preview, rollbackBatch, saveUpload, validateImport } from '../import/importService.ts';
import { addAttachment, deleteAttachment, getAttachmentFile } from '../services/attachments.ts';
import { coordinatorQueue, dashboard, myJobs } from '../services/dashboard.ts';
import { createEscalationRule, deleteEscalationRule, listEscalationRules, updateEscalationRule } from '../services/escalationRules.ts';
import { createHoliday, deleteHoliday, listHolidays, syncGoogleHolidays } from '../services/holidays.ts';
import {
  createMaster, isMasterKind, listClosureCategories, listMaster, masterNames, mergeMaster, saveClosureCategory, updateMaster,
} from '../services/masters.ts';
import { createReasonCode, listReasonCodes, updateReasonCode } from '../services/reasonCodes.ts';
import { createSlaRule, deleteSlaRule, listSlaRules } from '../services/slaRules.ts';
import { publicFormOptions, submitPublicRequest, trackPublicRequest } from '../services/publicService.ts';
import { intakeFormSubmission } from '../services/formIntake.ts';
import { legacyAllSection, PROJECTION as REPORT_PROJECTION, REPORTS, runReport } from '../services/reports.ts';
import { renderLegacyPdf } from '../services/pdfExport.ts';
import { buildFilter, createRequest, deleteRequest, getRequestDetail, listRequests, updateRequest } from '../services/requests.ts';
import { publicRolePermissions, updateRolePermissions } from '../services/rolePermissions.ts';
import { publicStageDefs, stageDef, updateStageDef } from '../services/stageDefs.ts';
import {
  addComment, assignEngineers, cancelRequest, completeStage, decideStage, editStage, fastCloseRequest, flagStage, holdRequest, reopenRequest, resumeRequest, skipStage, updateClosureNote,
} from '../services/stages.ts';
import { changeOwnPassword, createUser, listUsers, updateUser } from '../services/users.ts';
import { listAuditLog } from '../services/audit.ts';
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

// Called by the Apps Script trigger on the "Pending Complaint" Google Form's linked Sheet, on every new submission.
api.post('/public/form-intake', async (req, res) => {
  res.status(201).json(await intakeFormSubmission(req.body ?? {}, clientIp(req)));
});

// ---------------------------------------------------------------- auth
api.post('/auth/login', async (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (!username || !password) throw badRequest('Email / username and password are required');
  const user = await login(username, password, clientIp(req), res);
  res.json({ user, permissions: user.permissions });
});
api.post('/auth/logout', (_req, res) => { logout(res); res.json({ ok: true }); });

api.use(requireAuth);

api.get('/auth/me', (req, res) => { res.json({ user: req.user, permissions: req.user!.permissions }); });
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

// Access control itself is deliberately admin-only (not gated by an editable permission), so an
// admin can never edit themselves out of the one screen that could undo the mistake.
const requireAdmin = (req: Request, res: any, next: any) => (req.user!.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' }));
api.get('/permissions', requireAdmin, (_req, res) => { res.json(publicRolePermissions()); });
api.patch('/permissions/:role', requireAdmin, async (req, res) => {
  await updateRolePermissions(String(req.params.role), req.body?.permissions);
  res.json(publicRolePermissions());
});

// ---------------------------------------------------------------- job cards (/requests)
api.get('/requests', async (req, res) => { res.json(await listRequests(req.query, req.user!)); });
api.get('/requests/export.csv', async (req, res) => {
  const { filter } = buildFilter(req.query, req.user!);
  const [rows, names] = await Promise.all([
    col.requests().find(filter, { projection: REPORT_PROJECTION }).sort({ requested_at: 1 }).toArray(),
    masterNames(),
  ]);
  const section = await legacyAllSection(rows, names);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="job-cards.csv"');
  res.send(toCsv(section.columns, section.rows));
});
api.get('/requests/export.pdf', async (req, res) => {
  const { filter } = buildFilter(req.query, req.user!);
  const [rows, names] = await Promise.all([
    col.requests().find(filter, { projection: REPORT_PROJECTION }).sort({ requested_at: 1 }).toArray(),
    masterNames(),
  ]);
  const section = await legacyAllSection(rows, names);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="job-cards.pdf"');
  const doc = renderLegacyPdf(section.columns, section.rows, section.title);
  doc.pipe(res);
  doc.end();
});
api.post('/requests', requirePermission('request.create'), evidenceUpload.array('images', 10), async (req, res) => {
  res.status(201).json(await createRequest(req.body ?? {}, req.user!, files(req)));
});
api.get('/requests/:id', async (req, res) => { res.json(await getRequestDetail(id(req), req.user!)); });
api.patch('/requests/:id', async (req, res) => {
  await updateRequest(id(req), req.body ?? {}, req.user!);
  res.json(await getRequestDetail(id(req), req.user!));
});
api.delete('/requests/:id', async (req, res) => { res.json(await deleteRequest(id(req), req.user!)); });

const stageKey = (req: Request) => stageDef(String(req.params.key)).key as StageKey;
const stageRoutes = { complete: completeStage, skip: skipStage, decision: decideStage, flag: flagStage } as const;
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

const actions = {
  hold: holdRequest, resume: resumeRequest, cancel: cancelRequest, reopen: reopenRequest, assign: assignEngineers, comments: addComment,
  'fast-close': fastCloseRequest, 'closure-note': updateClosureNote,
} as const;
for (const [name, fn] of Object.entries(actions)) {
  api.post(`/requests/:id/${name}`, async (req, res) => {
    await fn(id(req), req.body ?? {}, req.user!);
    res.json(await getRequestDetail(id(req), req.user!));
  });
}
api.post('/requests/:id/attachments', evidenceUpload.single('file'), async (req, res) => {
  await addAttachment(id(req), { stage_key: req.body?.stage_key, url: req.body?.url, caption: req.body?.caption, file: req.file, source: req.body?.source === 'comment' ? 'comment' : 'ui' }, req.user!);
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

// ---------------------------------------------------------------- holiday calendar (SLA working-day exclusions)
api.get('/masters/holidays', async (_req, res) => { res.json(await listHolidays()); });
api.post('/masters/holidays', requirePermission('masters.manage'), async (req, res) => { res.status(201).json(await createHoliday(req.body ?? {})); });
api.delete('/masters/holidays/:id', requirePermission('masters.manage'), async (req, res) => { await deleteHoliday(id(req)); res.json({ ok: true }); });
api.post('/masters/holidays/sync', requirePermission('masters.manage'), async (_req, res) => { res.json(await syncGoogleHolidays()); });

// ---------------------------------------------------------------- SLA rules (whole-job scoped override layer; CRUD only — see services/slaRules.ts TODO)
api.get('/masters/sla-rules', requirePermission('masters.manage'), async (_req, res) => { res.json(await listSlaRules()); });
api.post('/masters/sla-rules', requirePermission('masters.manage'), async (req, res) => { res.status(201).json(await createSlaRule(req.body ?? {})); });
api.delete('/masters/sla-rules/:id', requirePermission('masters.manage'), async (req, res) => { await deleteSlaRule(id(req)); res.json({ ok: true }); });

// ---------------------------------------------------------------- escalation rules (wired into coordinator queue severity/thresholds)
api.get('/masters/escalation-rules', requirePermission('masters.manage'), async (_req, res) => { res.json(await listEscalationRules()); });
api.post('/masters/escalation-rules', requirePermission('masters.manage'), async (req, res) => { res.status(201).json(await createEscalationRule(req.body ?? {})); });
api.patch('/masters/escalation-rules/:id', requirePermission('masters.manage'), async (req, res) => { await updateEscalationRule(id(req), req.body ?? {}); res.json({ ok: true }); });
api.delete('/masters/escalation-rules/:id', requirePermission('masters.manage'), async (req, res) => { await deleteEscalationRule(id(req)); res.json({ ok: true }); });

// ---------------------------------------------------------------- reason codes (hold / cancel / reopen quick-pick; closure already uses closure_categories)
api.get('/masters/reason-codes', async (req, res) => { res.json(await listReasonCodes(req.query.kind as string | undefined)); });
api.post('/masters/reason-codes', requirePermission('masters.manage'), async (req, res) => { res.status(201).json(await createReasonCode(req.body ?? {})); });
api.patch('/masters/reason-codes/:id', requirePermission('masters.manage'), async (req, res) => { await updateReasonCode(id(req), req.body ?? {}); res.json({ ok: true }); });

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
api.post('/users', requirePermission('users.manage'), async (req, res) => { res.status(201).json(await createUser(req.body ?? {}, req.user!)); });
api.patch('/users/:id', requirePermission('users.manage'), async (req, res) => { await updateUser(id(req), req.body ?? {}, req.user!); res.json({ ok: true }); });

api.get('/audit-log', requirePermission('audit.view'), async (_req, res) => { res.json(await listAuditLog()); });

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
