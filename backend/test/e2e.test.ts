// End-to-end API test: boots the real server on a throwaway in-memory MongoDB and walks a request through the whole workflow.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'fms-e2e-'));
const port = 4700 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}/api`;
let server: ChildProcess;
let mongo: MongoMemoryServer;

// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

class Client {
  cookie = '';
  async call(method: string, url: string, body?: unknown) {
    const headers: Record<string, string> = { 'X-Requested-With': 'fms' };
    if (this.cookie) headers.Cookie = this.cookie;
    let payload: any;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  get(url: string) { return this.call('GET', url); }
  post(url: string, body: unknown = {}) { return this.call('POST', url, body); }
  async login(username: string, password: string) {
    const r = await this.post('/auth/login', { username, password });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return this;
  }
}

const imageForm = (fields: Record<string, string>, withImage = true) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (withImage) fd.append('images', new Blob([PNG], { type: 'image/png' }), 'site.png');
  return fd;
};

before(async () => {
  mongo = await MongoMemoryServer.create();
  const env = { ...process.env, PORT: String(port), FMS_DATA_DIR: dataDir, ADMIN_PASSWORD: 'Admin@12345', MONGODB_URI: mongo.getUri(), MONGODB_DB: 'fms_test' };
  const seed = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/db/seed.ts'], { cwd: root, env });
  await new Promise((r) => seed.on('exit', r));
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    server.stdout!.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
  });
});

after(async () => {
  server?.kill();
  await mongo?.stop();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
});

test('rejects unauthenticated and header-less requests', async () => {
  const anon = new Client();
  assert.equal((await anon.get('/requests')).status, 401);
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('full lifecycle: public form → approvals → engineer → coordinator close', async () => {
  const admin = await new Client().login('admin', 'Admin@12345');
  const coord = await new Client().login('coordinator', 'Welcome@123');
  const ph = await new Client().login('projecthead', 'Welcome@123');
  const approver = await new Client().login('approver', 'Welcome@123');
  const eng = await new Client().login('kuldeep', 'Welcome@123');
  const viewer = await new Client().login('viewer', 'Welcome@123');

  const opts = (await new Client().get('/public/form-options')).body;
  const property = opts.properties[0].id;
  const category = opts.categories[0].id;
  const fields = { property_id: String(property), category_id: String(category), description: 'Washroom tap is leaking badly', requester_email: 'resident@example.com', work_type: 'maintenance', property_no: 'B-204', target_date: '2099-01-01', reason: 'Water wastage' };

  // image is compulsory
  const noImg = await new Client().post('/public/requests', imageForm(fields, false));
  assert.equal(noImg.status, 400);
  assert.match(noImg.body.error, /image/i);

  const pub = await new Client().post('/public/requests', imageForm(fields));
  assert.equal(pub.status, 201, JSON.stringify(pub.body));
  const track = await new Client().get(`/public/track/${pub.body.tracking_token}`);
  assert.equal(track.body.status, 'open');

  const list = await coord.get(`/requests?q=${pub.body.request_no}`);
  const id = list.body.rows[0].id;
  let d = (await coord.get(`/requests/${id}`)).body;
  assert.equal(d.request.current_stage_key, 'triage');
  assert.equal(d.attachments.filter((a: any) => a.stage_key === 'created').length, 1);

  // engineers cannot see unassigned work; viewers cannot act
  assert.equal((await eng.get(`/requests/${id}`)).status, 403);
  assert.equal((await viewer.post(`/requests/${id}/stages/triage/decision`, { decision: 'approved' })).status, 403);

  const engineers = (await admin.get('/masters/engineers')).body;
  const kuldeep = engineers.find((e: any) => e.name === 'Kuldeep').id;

  // coordinator approves at triage: PH + permission required, material not required
  let r = await coord.post(`/requests/${id}/stages/triage/decision`, {
    decision: 'approved', priority: 'high', site_engineer_id: kuldeep,
    requires_ph_discussion: true, requires_material: false, requires_permission: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.request.current_stage_key, 'site_visit');
  assert.equal(r.body.stages.find((s: any) => s.stage_key === 'material').status, 'skipped');

  // site engineer (linked login) does the site visit
  r = await eng.post(`/requests/${id}/stages/site_visit/complete`, { comments: 'Visited, washer needs replacing' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.request.status, 'pending_approval');

  // wrong role cannot approve PH discussion
  assert.equal((await approver.post(`/requests/${id}/stages/ph_discussion/decision`, { decision: 'approved' })).status, 403);
  r = await ph.post(`/requests/${id}/stages/ph_discussion/decision`, { decision: 'approved', comments: 'Go ahead' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await coord.post(`/requests/${id}/stages/communicate_requester/complete`, { comments: 'Called resident' });
  assert.equal(r.body.request.current_stage_key, 'permission');

  // approver rejects → on hold; coordinator resumes; approver approves
  r = await approver.post(`/requests/${id}/stages/permission/decision`, { decision: 'rejected', comments: 'Need quotation' });
  assert.equal(r.body.request.status, 'on_hold');
  r = await coord.post(`/requests/${id}/resume`, { comments: 'Quotation attached' });
  assert.equal(r.body.request.current_stage_key, 'permission');
  r = await approver.post(`/requests/${id}/stages/permission/decision`, { decision: 'approved' });
  assert.equal(r.body.request.current_stage_key, 'engineer_assigned');

  r = await coord.post(`/requests/${id}/stages/engineer_assigned/complete`, { engineer_id: kuldeep });
  assert.equal(r.body.request.assigned_engineer_id, kuldeep);
  const jobs = (await eng.get('/my-jobs')).body;
  assert.ok([...jobs.overdue, ...jobs.today, ...jobs.upcoming].some((j: any) => j.id === id), 'job appears in engineer My Jobs');
  const queue = (await coord.get('/coordinator/queue')).body;
  assert.ok(Array.isArray(queue.items));

  r = await eng.post(`/requests/${id}/stages/work_started/complete`, {});
  assert.equal(r.body.request.current_stage_key, 'work_completed');

  // completion evidence is compulsory
  const noEv = await eng.post(`/requests/${id}/stages/work_completed/complete`, {});
  assert.equal(noEv.status, 400);
  const ev = new FormData();
  ev.append('stage_key', 'work_completed');
  ev.append('file', new Blob([PNG], { type: 'image/png' }), 'done.png');
  assert.equal((await eng.post(`/requests/${id}/attachments`, ev)).status, 201);
  r = await eng.post(`/requests/${id}/stages/work_completed/complete`, { comments: 'Washer replaced' });
  assert.equal(r.body.request.status, 'completed');

  // verification fail → rework, then pass
  r = await ph.post(`/requests/${id}/stages/verification/decision`, { decision: 'rejected', comments: 'Still dripping' });
  assert.equal(r.body.request.current_stage_key, 'work_completed');
  r = await eng.post(`/requests/${id}/stages/work_completed/complete`, { comments: 'Fixed properly' });
  r = await ph.post(`/requests/${id}/stages/verification/decision`, { decision: 'approved' });
  assert.equal(r.body.request.current_stage_key, 'closed');

  // only the coordinator closes
  assert.equal((await eng.post(`/requests/${id}/stages/closed/complete`, { closure_category: 'Work Done' })).status, 403);
  r = await coord.post(`/requests/${id}/stages/closed/complete`, { closure_category: 'Work Done' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.request.status, 'closed');

  const tracked = (await new Client().get(`/public/track/${pub.body.tracking_token}`)).body;
  assert.equal(tracked.status, 'closed');

  // triage rejection cancels the request
  const pub2 = (await new Client().post('/public/requests', imageForm({ ...fields, description: 'Duplicate of an older complaint' }))).body;
  const id2 = (await coord.get(`/requests?q=${pub2.request_no}`)).body.rows[0].id;
  r = await coord.post(`/requests/${id2}/stages/triage/decision`, { decision: 'rejected', comments: 'Duplicate' });
  assert.equal(r.body.request.status, 'cancelled');
});

test('dashboard, reports and board respond', async () => {
  const admin = await new Client().login('admin', 'Admin@12345');
  const dash = await admin.get('/dashboard');
  assert.equal(dash.status, 200);
  for (const k of ['open_jobs', 'due_today', 'overdue', 'waiting_material', 'waiting_approval', 'in_progress', 'verification_pending', 'closed_30d', 'reopened']) assert.ok(k in dash.body.kpi, k);
  for (const key of ['property', 'category', 'engineer', 'stage', 'pending', 'completed', 'delayed', 'tat', 'historical']) {
    const rep = await admin.get(`/reports/${key}`);
    assert.equal(rep.status, 200, `${key}: ${JSON.stringify(rep.body)}`);
  }
  assert.equal((await admin.get('/coordinator/queue')).status, 200);
});

const FMS = process.env.FMS_FILE ?? 'C:/Users/my/Downloads/FIR  Card -Work Capture  FMS  - FMS.tsv';
test('imports the FMS sheet through the wizard API', { skip: !existsSync(FMS) && 'FMS file not available' }, async () => {
  const admin = await new Client().login('admin', 'Admin@12345');
  const fd = new FormData();
  fd.append('file', new Blob([readFileSync(FMS)], { type: 'text/tab-separated-values' }), path.basename(FMS));
  const up = await admin.post('/imports/upload', fd);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.mapping['36'], 'stage.work_completed.engineer', 'unnamed column AK detected as engineer');
  const v = await admin.post(`/imports/uploads/${up.body.upload_id}/validate`, { mapping: up.body.mapping, options: up.body.default_options });
  assert.equal(v.body.summary.error_rows, 0);
  const c = await admin.post(`/imports/uploads/${up.body.upload_id}/commit`, { mapping: up.body.mapping, options: up.body.default_options });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.created, v.body.summary.create);
  const batch = await admin.get(`/imports/${c.body.batch_id}`);
  assert.equal(batch.body.can_rollback, true);
  const hist = await admin.get('/reports/historical');
  assert.ok(hist.body.sections[0].rows.length >= c.body.created);
});
