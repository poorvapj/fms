import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { ImagePicker } from '../components/ImagePicker';
import { Empty, ErrorBox, Field, Loading, Modal, OverdueBadge, PriorityBadge, SourceBadge, StageStatusBadge, StatusBadge } from '../components/ui';
import { API_BASE, api, errorText } from '../lib/api';
import { useAuth, useMeta } from '../lib/auth';
import { cap, fmtBytes, fmtDate, fmtDateTime, fmtDuration, nowInput } from '../lib/format';
import { useLoad } from '../lib/hooks';
import type { Attachment, RequestDetail as Detail, Stage, User } from '../lib/types';

// ---------------------------------------------------------------------------------------------------- helpers

function canAct(user: User, roles: string[], stage: Stage, req: Detail['request']) {
  if (!roles.includes(user.role)) return false;
  if (user.role !== 'engineer') return true;
  if (!user.engineer_id) return false;
  if (stage.stage_key === 'site_visit') return req.site_engineer_id === user.engineer_id || stage.engineer_id === user.engineer_id;
  return req.assigned_engineer_id === user.engineer_id || stage.engineer_id === user.engineer_id;
}

const fileUrl = (a: Attachment) => (a.kind === 'file' ? `${API_BASE}/attachments/${a.id}/file` : a.url ?? '#');

function Evidence({ items }: { items: Attachment[] }) {
  if (!items.length) return null;
  return (
    <div className="evidence">
      {items.map((a) =>
        a.kind === 'file' && a.mime?.startsWith('image/') ? (
          <a key={a.id} href={fileUrl(a)} target="_blank" rel="noreferrer" title={a.caption ?? a.file_name ?? ''} style={{ padding: 0, border: 0 }}>
            <img className="thumb" src={fileUrl(a)} alt={a.caption ?? a.file_name ?? 'image'} loading="lazy" />
          </a>
        ) : (
          <a key={a.id} href={fileUrl(a)} target="_blank" rel="noreferrer noopener">
            <Icon name={a.kind === 'url' ? 'link' : 'file'} size={13} />
            {a.caption ?? a.file_name ?? 'Link'}{a.size ? ` · ${fmtBytes(a.size)}` : ''}
          </a>
        ),
      )}
    </div>
  );
}

function DelayText({ stage, onHold }: { stage: Stage; onHold: boolean }) {
  if (stage.status === 'completed') {
    if (stage.delay_minutes === null) return <span className="muted">—</span>;
    return stage.delay_minutes > 0 ? <span className="late-text">{fmtDuration(stage.delay_minutes)} late</span> : <span className="ontime-text">On time</span>;
  }
  if (stage.status === 'active' && stage.running_delay_minutes && !onHold) return <span className="late-text">{fmtDuration(stage.running_delay_minutes)} overdue</span>;
  return <span className="muted">—</span>;
}

// ---------------------------------------------------------------------------------------------------- workflow stepper (horizontal) + detail-on-click

/** Node status class for the compact stepper dot / connecting line. */
function stepClass(s: Stage, onHold: boolean): string {
  const late = s.status === 'completed' && (s.delay_minutes ?? 0) > 0;
  const overdue = s.status === 'active' && !onHold && (s.running_delay_minutes ?? 0) > 0;
  return [s.status, late || overdue ? 'late' : ''].filter(Boolean).join(' ');
}

function StepDot({ s }: { s: Stage }) {
  if (s.status === 'completed') return <Icon name="check" size={13} />;
  if (s.status === 'rejected') return <Icon name="x" size={13} />;
  if (s.status === 'skipped') return <Icon name="skip" size={11} />;
  return <span className="step-num">{s.seq}</span>;
}

function WorkflowStepper({ d, selected, onSelect }: { d: Detail; selected: string; onSelect: (key: string) => void }) {
  const onHold = d.request.status === 'on_hold';
  const stepperRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  // Keep whichever stage is selected in view — a job far along the workflow shouldn't need a manual scroll to see it.
  // Scrolls only the stepper's own scroll container (never the page): scrollIntoView() would otherwise
  // walk up every scrollable ancestor, including the page itself on narrow screens.
  useEffect(() => {
    const track = stepperRef.current;
    const btn = selectedRef.current;
    if (!track || !btn) return;
    const target = btn.offsetLeft - track.clientWidth / 2 + btn.offsetWidth / 2;
    track.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
  }, [selected]);
  return (
    <div className="stepper" ref={stepperRef}>
      {d.stages.map((s, i) => (
        <div className="step-wrap" key={s.stage_key}>
          <button
            ref={s.stage_key === selected ? selectedRef : undefined}
            type="button"
            className={`step ${stepClass(s, onHold)}${s.stage_key === selected ? ' selected' : ''}`}
            onClick={() => onSelect(s.stage_key)}
            title={s.name}
          >
            <span className="step-dot"><StepDot s={s} /></span>
            <span className="step-label">{s.name}</span>
          </button>
          {i < d.stages.length - 1 && <span className={`step-line ${s.status === 'completed' ? 'done' : ''}`} />}
        </div>
      ))}
    </div>
  );
}

/** Detail card for whichever single stage is selected in the stepper — the full picture, without repeating it 12×. */
function StageDetail({ d, stageKey, onEdit, canEdit }: { d: Detail; stageKey: string; onEdit: (s: Stage) => void; canEdit: boolean }) {
  const s = d.stages.find((x) => x.stage_key === stageKey);
  if (!s) return null;
  const onHold = d.request.status === 'on_hold';
  const late = s.status === 'completed' && (s.delay_minutes ?? 0) > 0;
  const ev = d.attachments.filter((a) => a.stage_key === s.stage_key);
  const person = s.engineer_name && s.engineer_name !== s.responsible_name ? `${s.responsible_name ?? '—'} · Engg: ${s.engineer_name}` : s.responsible_name ?? s.engineer_name;
  return (
    <div className="tl-card">
      <div className="tl-top">
        <span className="tl-title">{s.name}</span>
        {s.optional && <span className="badge inferred">optional</span>}
        <StageStatusBadge status={s.status} late={late} />
        {s.decision && <span className={`badge ${s.decision === 'approved' ? 'closed' : 'cancelled'}`}>{cap(s.decision)}</span>}
        {s.source === 'fms_import' && <span className="badge src">FMS</span>}
        <span className="grow" />
        {canEdit && s.stage_key !== 'created' && <button className="btn sm ghost" onClick={() => onEdit(s)} title="Correct this stage"><Icon name="edit" size={13} />Edit</button>}
      </div>
      {s.status !== 'skipped' ? (
        <div className="tl-grid">
          <div><div className="k">Planned</div><div className="v">{fmtDateTime(s.planned_at)}{s.planned_inferred && <> <span className="badge inferred" title="Derived from SLA rule — blank in FMS">SLA</span></>}</div></div>
          <div><div className="k">Actual</div><div className="v">{fmtDateTime(s.actual_at)}{s.actual_inferred && <> <span className="badge inferred" title="Taken from Work Completion (no separate record in FMS)">inferred</span></>}</div></div>
          <div><div className="k">Status</div><div className="v">{s.status === 'active' ? 'Current stage' : cap(s.status)}</div></div>
          <div><div className="k">Delay</div><div className="v"><DelayText stage={s} onHold={onHold} /></div></div>
          <div><div className="k">Person</div><div className="v">{person ?? <span className="muted">{s.responsible_role ?? '—'}</span>}</div></div>
        </div>
      ) : (
        s.comments && <div className="muted small" style={{ padding: '8px 12px' }}>{s.comments}</div>
      )}
      {((s.status !== 'skipped' && s.comments) || ev.length > 0 || s.legacy) && (
        <div className="tl-extra">
          {s.status !== 'skipped' && s.comments && <div><Icon name="message" size={13} /> {s.comments}</div>}
          <Evidence items={ev} />
          {s.legacy && (
            <div className="muted small">
              FMS sheet values: {Object.entries(s.legacy).map(([k, v]) => `${cap(k)} “${v}”`).join(' · ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------- action panel

function StageActionPanel({ d, onDone }: { d: Detail; onDone: (nd: Detail) => void }) {
  const meta = useMeta();
  const { user } = useAuth();
  const stage = d.stages.find((s) => s.status === 'active');
  const r = d.request;
  const def = stage ? meta.stages.find((m) => m.key === stage.stage_key) : null;
  const [comments, setComments] = useState('');
  const [actualAt, setActualAt] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<'approve' | 'reject' | 'skip'>('approve');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!stage || !def || !user || r.status === 'on_hold' || r.status === 'cancelled') return null;
  if (!canAct(user, def.roles, stage, r)) {
    return (
      <div className="alert info" style={{ marginBottom: 16 }}>
        <Icon name="clock" />
        <div>Waiting on <b>{def.name}</b> — responsibility: {def.responsible_label}{stage.planned_at ? `, due ${fmtDateTime(stage.planned_at)}` : ''}.</div>
      </div>
    );
  }
  const key = stage.stage_key;
  const setX = (k: string) => (e: { target: { value: string } }) => setExtra({ ...extra, [k]: e.target.value });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'skip') {
        onDone(await api.post<Detail>(`/requests/${r.id}/stages/${key}/skip`, { reason: comments }));
        return;
      }
      for (const f of files) {
        const fd = new FormData();
        fd.append('file', f);
        fd.append('stage_key', key);
        fd.append('caption', key === 'work_completed' ? 'Completion evidence' : `${def.name} evidence`);
        await api.post(`/requests/${r.id}/attachments`, fd);
      }
      setFiles([]);
      const body: Record<string, unknown> = { comments, actual_at: actualAt || undefined, ...extra };
      if (key === 'triage') {
        for (const k of ['requires_ph_discussion', 'requires_material', 'requires_permission']) body[k] = extra[k] === 'yes';
      }
      const url = def.decision ? `/requests/${r.id}/stages/${key}/decision` : `/requests/${r.id}/stages/${key}/complete`;
      if (def.decision) body.decision = mode === 'reject' ? 'rejected' : 'approved';
      onDone(await api.post<Detail>(url, body));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const hasEvidence = d.attachments.some((a) => a.stage_key === key) || files.length > 0;
  const needsFlags = key === 'triage' && mode === 'approve';
  const flagsAnswered = !needsFlags || ['requires_ph_discussion', 'requires_material', 'requires_permission'].every((k) => extra[k]);
  const disabled = busy
    || (mode !== 'approve' && !comments.trim())
    || (key === 'work_completed' && def.requires_evidence && !hasEvidence)
    || (key === 'engineer_assigned' && !(extra.engineer_id || r.assigned_engineer_id))
    || (needsFlags && (!flagsAnswered || !(extra.site_engineer_id || r.site_engineer_id)))
    || (key === 'closed' && !extra.closure_category);

  const yesNo = (k: string, label: string) => (
    <Field label={label} required>
      <div className="seg">
        {['yes', 'no'].map((v) => <button type="button" key={v} className={extra[k] === v ? 'on' : ''} onClick={() => setExtra({ ...extra, [k]: v })}>{cap(v)}</button>)}
      </div>
    </Field>
  );

  const verb: Record<string, string> = {
    triage: 'Approve job card', site_visit: 'Site visit done', communicate_requester: 'Requester informed', engineer_assigned: 'Assign & inform engineer',
    work_started: 'Mark work started', work_completed: 'Mark work completed', closed: 'Close request',
  };

  return (
    <div className="card action-panel" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <Icon name="play" />
        <h2>Current stage: {def.name}</h2>
        <span className="muted small">{def.sla_text}{stage.planned_at ? ` · due ${fmtDateTime(stage.planned_at)}` : ''}</span>
      </div>
      <div className="card-body stack">
        {(def.decision || def.optional) && (
          <div className="seg" role="radiogroup">
            <button type="button" className={mode === 'approve' ? 'on' : ''} onClick={() => setMode('approve')}>{def.decision ? 'Approve' : 'Complete'}</button>
            {def.decision && <button type="button" className={mode === 'reject' ? 'on' : ''} onClick={() => setMode('reject')}>{key === 'verification' ? 'Send back for rework' : 'Reject'}</button>}
            {def.optional && <button type="button" className={mode === 'skip' ? 'on' : ''} onClick={() => setMode('skip')}>Not required</button>}
          </div>
        )}
        {mode === 'approve' && (
          <div className="form-grid">
            {key === 'triage' && <>
              <Field label="Priority">
                <select className="select" value={extra.priority ?? r.priority} onChange={setX('priority')}>
                  {meta.priorities.map((p) => <option key={p} value={p}>{cap(p)}</option>)}
                </select>
              </Field>
              <Field label="Site engineer (for site visit)" required>
                <select className="select" value={extra.site_engineer_id ?? r.site_engineer_id ?? ''} onChange={setX('site_engineer_id')}>
                  <option value="">Select engineer…</option>
                  {meta.engineers.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </Field>
              {yesNo('requires_ph_discussion', 'Project Head discussion needed?')}
              {yesNo('requires_material', 'Material / dependency needed?')}
              {yesNo('requires_permission', 'Management permission needed?')}
            </>}
            {key === 'engineer_assigned' && (
              <Field label="Engineer to carry out the work" required>
                <select className="select" value={extra.engineer_id ?? r.assigned_engineer_id ?? ''} onChange={setX('engineer_id')}>
                  <option value="">Select engineer…</option>
                  {meta.engineers.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </Field>
            )}
            {key === 'closed' && <>
              <Field label="Closure category" required>
                <select className="select" value={extra.closure_category ?? ''} onChange={setX('closure_category')}>
                  <option value="">Select…</option>
                  {meta.closure_categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                </select>
              </Field>
              <Field label="Closure note"><input className="input" value={extra.closure_note ?? ''} onChange={setX('closure_note')} /></Field>
            </>}
            {key === 'verification' && (
              <Field label="Verified by"><input className="input" placeholder={user.name} value={extra.verified_by_name ?? ''} onChange={setX('verified_by_name')} /></Field>
            )}
            {key !== 'triage' && (
              <Field label="Actual date & time" help="Leave blank for now">
                <input type="datetime-local" className="input" max={nowInput()} value={actualAt} onChange={(e) => setActualAt(e.target.value)} />
              </Field>
            )}
          </div>
        )}
        {mode === 'approve' && ['site_visit', 'work_started', 'work_completed', 'material'].includes(key) && (
          <Field label={key === 'work_completed' ? 'Completion evidence (photo)' : 'Evidence (optional)'} required={key === 'work_completed' && def.requires_evidence}
            help={key === 'work_completed' && d.attachments.some((a) => a.stage_key === key) ? 'Evidence already attached — you may add more.' : undefined}>
            <ImagePicker files={files} onChange={setFiles} onError={setError} />
          </Field>
        )}
        <Field label={mode === 'approve' ? 'Comments' : mode === 'skip' ? 'Why is this stage not required?' : 'Reason'} required={mode !== 'approve'}>
          <textarea className="input" style={{ minHeight: 64 }} value={comments} onChange={(e) => setComments(e.target.value)} maxLength={4000} />
        </Field>
        <ErrorBox error={error} />
        <div className="row">
          <button className={`btn ${mode === 'reject' ? 'danger' : 'primary'}`} disabled={disabled} onClick={submit}>
            {busy ? 'Saving…' : mode === 'reject' ? (key === 'verification' ? 'Send back for rework' : key === 'triage' ? 'Reject job card' : 'Reject') : mode === 'skip' ? 'Mark not required' : def.decision && key !== 'triage' ? 'Approve' : verb[key] ?? 'Complete stage'}
          </button>
          {key === 'triage' && mode === 'reject' && <span className="muted small">The job card will be cancelled as not approved (it can be reinstated later).</span>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------- side panels

function RequestActions({ d, onDone }: { d: Detail; onDone: (nd: Detail) => void }) {
  const meta = useMeta();
  const [dialog, setDialog] = useState<null | 'hold' | 'resume' | 'cancel' | 'reopen' | 'assign'>(null);
  const [text, setText] = useState('');
  const [site, setSite] = useState(String(d.request.site_engineer_id ?? ''));
  const [eng, setEng] = useState(String(d.request.assigned_engineer_id ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = d.request;
  const live = !['closed', 'cancelled'].includes(r.status);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = dialog === 'assign' ? { site_engineer_id: site || null, assigned_engineer_id: eng || null } : dialog === 'resume' ? { comments: text } : { reason: text };
      onDone(await api.post<Detail>(`/requests/${r.id}/${dialog}`, body));
      setDialog(null);
      setText('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const titles = { hold: 'Put on hold', resume: 'Resume job card', cancel: 'Cancel job card', reopen: r.status === 'cancelled' ? 'Reinstate job card' : 'Reopen for rework', assign: 'Reassign engineers' };

  return (
    <div className="card">
      <div className="card-head"><h3>Coordinator actions</h3></div>
      <div className="card-body row wrap">
        {live && r.status !== 'on_hold' && <button className="btn sm" onClick={() => setDialog('assign')}><Icon name="users" size={13} />Reassign</button>}
        {live && r.status !== 'on_hold' && <button className="btn sm" onClick={() => setDialog('hold')}><Icon name="pause" size={13} />Hold</button>}
        {r.status === 'on_hold' && <button className="btn sm primary" onClick={() => setDialog('resume')}><Icon name="play" size={13} />Resume</button>}
        {live && <button className="btn sm danger" onClick={() => setDialog('cancel')}><Icon name="x" size={13} />Cancel</button>}
        {['closed', 'completed', 'cancelled'].includes(r.status) && <button className="btn sm" onClick={() => setDialog('reopen')}><Icon name="rotate" size={13} />{titles.reopen}</button>}
      </div>
      {dialog && (
        <Modal title={titles[dialog]} onClose={() => setDialog(null)} footer={<>
          <button className="btn" onClick={() => setDialog(null)}>Close</button>
          <button className={`btn ${dialog === 'cancel' ? 'danger' : 'primary'}`} disabled={busy || (dialog !== 'assign' && dialog !== 'resume' && !text.trim())} onClick={run}>{busy ? 'Saving…' : 'Confirm'}</button>
        </>}>
          {dialog === 'assign' ? <>
            <Field label="Site engineer">
              <select className="select" value={site} onChange={(e) => setSite(e.target.value)}>
                <option value="">None</option>{meta.engineers.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </Field>
            <Field label="Work engineer">
              <select className="select" value={eng} onChange={(e) => setEng(e.target.value)}>
                <option value="">None</option>{meta.engineers.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </Field>
          </> : (
            <Field label={dialog === 'resume' ? 'Comment (optional)' : 'Reason'} required={dialog !== 'resume'}>
              <textarea className="input" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
            </Field>
          )}
          <ErrorBox error={error} />
        </Modal>
      )}
    </div>
  );
}

function CommentBox({ d, onDone }: { d: Detail; onDone: (nd: Detail) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState('');
  const post = async (kind: 'comment' | 'link') => {
    setBusy(true);
    setError(null);
    try {
      onDone(kind === 'comment'
        ? await api.post<Detail>(`/requests/${d.request.id}/comments`, { comment: text })
        : await api.post<Detail>(`/requests/${d.request.id}/attachments`, { url: link, stage_key: d.request.current_stage_key ?? undefined }));
      setText('');
      setLink('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <div className="card-head"><h3>Add comment or link</h3></div>
      <div className="card-body stack">
        <textarea className="input" style={{ minHeight: 60 }} placeholder="Write a comment…" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn sm" disabled={busy || !text.trim()} onClick={() => post('comment')}>Post comment</button>
        <div className="row">
          <input className="input" placeholder="https://… (photo / document link)" value={link} onChange={(e) => setLink(e.target.value)} />
          <button className="btn sm" disabled={busy || !/^https?:\/\//.test(link)} onClick={() => post('link')}>Add</button>
        </div>
        <ErrorBox error={error} />
      </div>
    </div>
  );
}

function EditStageModal({ d, stage, onClose, onDone }: { d: Detail; stage: Stage; onClose: () => void; onDone: (nd: Detail) => void }) {
  const meta = useMeta();
  const [f, setF] = useState({
    status: stage.status, planned_at: stage.planned_at?.slice(0, 16) ?? '', actual_at: stage.actual_at?.slice(0, 16) ?? '',
    engineer_id: String(stage.engineer_id ?? ''), comments: stage.comments ?? '', reason: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    try {
      onDone(await api.patch<Detail>(`/requests/${d.request.id}/stages/${stage.stage_key}`, { ...f, engineer_id: f.engineer_id || null, planned_at: f.planned_at || null, actual_at: f.actual_at || null }));
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={`Correct stage — ${stage.name}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy || !f.reason.trim()} onClick={save}>Save correction</button>
    </>}>
      <div className="alert warn"><Icon name="history" />Corrections are recorded in the activity log with your reason.</div>
      <div className="form-grid">
        <Field label="Status">
          <select className="select" value={f.status} onChange={set('status')}>
            {['pending', 'active', 'completed', 'skipped', 'rejected'].map((s) => <option key={s} value={s}>{cap(s)}</option>)}
          </select>
        </Field>
        <Field label="Engineer">
          <select className="select" value={f.engineer_id} onChange={set('engineer_id')}>
            <option value="">None</option>{meta.engineers.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </Field>
        <Field label="Planned"><input type="datetime-local" className="input" value={f.planned_at} onChange={set('planned_at')} /></Field>
        <Field label="Actual"><input type="datetime-local" className="input" value={f.actual_at} onChange={set('actual_at')} /></Field>
        <Field label="Comments" full><textarea className="input" value={f.comments} onChange={set('comments')} /></Field>
        <Field label="Reason for correction" required full><input className="input" value={f.reason} onChange={set('reason')} /></Field>
      </div>
      <ErrorBox error={error} />
    </Modal>
  );
}

function LegacyRow({ legacy }: { legacy: NonNullable<Detail['legacy']> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card">
      <div className="card-head">
        <h3>Original FMS row</h3>
        <span className="muted small">Sheet row {legacy.row_no}</span>
        <div className="actions"><button className="btn sm" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</button></div>
      </div>
      {open && (
        <div className="card-body flush table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table className="table compact">
            <tbody>
              {legacy.cells.filter((c) => c.value.trim()).map((c) => (
                <tr key={c.index}>
                  <td className="muted small nowrap">{[c.group, c.header || `(column ${c.index})`].filter(Boolean).join(' › ')}</td>
                  <td className="small" style={{ wordBreak: 'break-word' }}>{/^https?:\/\//.test(c.value) ? <a href={c.value.split(/[ ,]/)[0]} target="_blank" rel="noreferrer noopener">{c.value}</a> : c.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted small" style={{ padding: '8px 12px' }}>From {legacy.file_name} · <Link to={`/import/${legacy.batch_id}`}>import batch #{legacy.batch_id}</Link></div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------- page

export function RequestDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data, error, loading, reload, setData } = useLoad(() => api.get<Detail>(`/requests/${id}`), [id]);
  const [editing, setEditing] = useState<Stage | null>(null);
  const [manualStage, setManualStage] = useState<string | null>(null);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;
  const r = data.request;
  const defaultStage = r.current_stage_key ?? [...data.stages].reverse().find((s) => s.status === 'completed')?.stage_key ?? data.stages[0]?.stage_key ?? '';
  const selectedStage = manualStage ?? defaultStage;
  const fact = (k: string, v: ReactNode) => <div className="fact"><div className="k">{k}</div><div className="v">{v ?? '—'}</div></div>;
  const locationImages = data.attachments.filter((a) => a.stage_key === 'created');
  const otherFiles = data.attachments.filter((a) => a.stage_key !== 'created');

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}><Link to="/job-cards" className="small">← Job Cards</Link></div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="job-head">
          <div className="grow">
            <div className="no">{r.request_no}</div>
            <h1>{r.title}</h1>
            <div className="row wrap">
              <StatusBadge status={r.status} />
              <PriorityBadge priority={r.priority} />
              <SourceBadge source={r.source} />
              {r.is_overdue && <OverdueBadge minutes={r.overdue_minutes} />}
              {r.current_stage_name && <span className="muted">Current stage: <b style={{ color: 'var(--text)' }}>{r.current_stage_name}</b>{r.current_stage_planned_at ? ` · due ${fmtDateTime(r.current_stage_planned_at)}` : ''}</span>}
            </div>
          </div>
        </div>
        {(r.hold_reason || r.cancel_reason) && (
          <div style={{ padding: '0 20px 14px' }}>
            <div className={`alert ${r.cancel_reason ? 'error' : 'warn'}`}><Icon name="alert" />{r.cancel_reason ? `Cancelled: ${r.cancel_reason}` : `On hold: ${r.hold_reason}`}</div>
          </div>
        )}
        <div className="facts">
          {fact('Property', r.property_name)}
          {fact('Work category', r.category_name)}
          {fact('Raised', fmtDateTime(r.requested_at))}
          {fact('Work completion date', fmtDate(r.target_date))}
          {fact('Property No.', r.property_no)}
          {fact('Work', r.work_type === 'new_work' ? 'New Work' : r.work_type === 'maintenance' ? 'Maintenance' : null)}
          {fact('Requester', [r.requester_name, r.requester_email, r.requester_contact].filter(Boolean).join(' · ') || null)}
          {fact('Site engineer', r.site_engineer_name)}
          {fact('Work engineer', r.engineer_name)}
          {fact(r.status === 'closed' ? 'Closed' : 'Work completed', fmtDateTime(r.closed_at ?? r.completed_at))}
          {r.closure_category && fact('Closure', r.closure_category)}
          {r.verified_by_name && fact('Verified by', r.verified_by_name)}
        </div>
      </div>

      <div className="grid grid-sidebar">
        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head"><h2>Workflow</h2><span className="muted small">Click a stage for its details</span></div>
            <div className="card-body stack">
              <WorkflowStepper d={data} selected={selectedStage} onSelect={setManualStage} />
              <StageDetail d={data} stageKey={selectedStage} onEdit={setEditing} canEdit={can('stage.edit_history')} />
            </div>
          </div>
          <StageActionPanel key={`${r.current_stage_key}-${r.status}`} d={data} onDone={setData} />
        </div>
        <div className="stack">
          <div className="card">
            <div className="card-head"><h3>Narration</h3></div>
            <div className="card-body stack">
              <div style={{ whiteSpace: 'pre-wrap' }}>{r.description ?? <span className="muted">No description</span>}</div>
              {r.reason && <div className="small"><span className="muted">Reason:</span> {r.reason}</div>}
              {r.location_detail && <div className="small"><span className="muted">Location:</span> {r.location_detail}</div>}
              <Evidence items={locationImages} />
              {r.closure_note && <div className="small"><span className="muted">Closure note:</span> {r.closure_note}</div>}
            </div>
          </div>
          {can('request.manage') && <RequestActions d={data} onDone={setData} />}
          {can('request.comment') && <CommentBox d={data} onDone={setData} />}
          {otherFiles.length > 0 && (
            <div className="card">
              <div className="card-head"><h3>Evidence & attachments</h3><span className="muted small">{otherFiles.length}</span></div>
              <div className="card-body"><Evidence items={otherFiles} /></div>
            </div>
          )}
          <div className="card">
            <div className="card-head"><h3>Activity</h3></div>
            {data.events.length === 0 ? <Empty title="No activity" /> : (
              <ul className="events" style={{ maxHeight: 420, overflowY: 'auto' }}>
                {data.events.map((e) => (
                  <li key={e.id}>{e.message}<div className="meta">{e.user_name} · {fmtDateTime(e.created_at)}</div></li>
                ))}
              </ul>
            )}
          </div>
          {data.legacy && <LegacyRow legacy={data.legacy} />}
        </div>
      </div>
      {editing && <EditStageModal d={data} stage={editing} onClose={() => setEditing(null)} onDone={setData} />}
    </>
  );
}
