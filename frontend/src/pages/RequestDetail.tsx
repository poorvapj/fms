import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { ImagePicker } from '../components/ImagePicker';
import { Empty, ErrorBox, Field, Loading, Modal, StageStatusBadge, StatusBadge, Tabs } from '../components/ui';
import { API_BASE, api, errorText } from '../lib/api';
import { useAuth, useMeta } from '../lib/auth';
import { cap, fmtBytes, fmtDate, fmtDateTime, fmtDuration } from '../lib/format';
import { useLoad } from '../lib/hooks';
import type { Attachment, RequestDetail as Detail, Stage } from '../lib/types';

// ---------------------------------------------------------------------------------------------------- helpers

const fileUrl = (a: Attachment) => (a.kind === 'file' ? `${API_BASE}/attachments/${a.id}/file` : a.url ?? '#');

/** Google Drive share links don't serve the image directly — pull the file id out so we can use Drive's thumbnail endpoint. */
function driveThumb(url: string): string | null {
  const m = /\/file\/d\/([\w-]+)/.exec(url) ?? /[?&]id=([\w-]+)/.exec(url);
  return m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w500` : null;
}

function Evidence({ items, onDelete }: { items: Attachment[]; onDelete?: (id: number) => void }) {
  if (!items.length) return null;
  const remove = async (a: Attachment) => {
    if (!window.confirm('Remove this attachment?')) return;
    try { await api.del(`/attachments/${a.id}`); onDelete?.(a.id); }
    catch (e) { window.alert(errorText(e)); }
  };
  const DeleteBtn = ({ a }: { a: Attachment }) => (
    onDelete ? (
      <button
        type="button" aria-label="Remove" title="Remove"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); remove(a); }}
        style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%', border: 0, background: 'var(--bad, #c23)', color: '#fff', lineHeight: '20px', padding: 0, cursor: 'pointer' }}
      >
        ×
      </button>
    ) : null
  );
  return (
    <div className="evidence">
      {items.map((a) => {
        if (a.kind === 'file' && a.mime?.startsWith('image/')) {
          return (
            <div key={a.id} style={{ position: 'relative' }}>
              <a href={fileUrl(a)} target="_blank" rel="noreferrer" title={a.caption ?? a.file_name ?? ''} style={{ padding: 0, border: 0 }}>
                <img className="thumb" src={fileUrl(a)} alt={a.caption ?? a.file_name ?? 'image'} loading="lazy" />
              </a>
              <DeleteBtn a={a} />
            </div>
          );
        }
        const thumb = a.kind === 'url' && a.url ? driveThumb(a.url) : null;
        if (thumb) {
          return (
            <div key={a.id} style={{ position: 'relative' }}>
              <a href={a.url!} target="_blank" rel="noreferrer noopener" title={a.caption ?? 'image'} style={{ padding: 0, border: 0 }}>
                <img
                  className="thumb" src={thumb} alt={a.caption ?? 'image'} loading="lazy"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                    (e.currentTarget.nextElementSibling as HTMLElement | null)?.style.removeProperty('display');
                  }}
                />
                <span style={{ display: 'none' }}><Icon name="link" size={13} />{a.caption ?? 'Link'}</span>
              </a>
              <DeleteBtn a={a} />
            </div>
          );
        }
        return (
          <div key={a.id} style={{ position: 'relative' }}>
            <a href={fileUrl(a)} target="_blank" rel="noreferrer noopener">
              <Icon name={a.kind === 'url' ? 'link' : 'file'} size={13} />
              {a.caption ?? a.file_name ?? 'Link'}{a.size ? ` · ${fmtBytes(a.size)}` : ''}
            </a>
            <DeleteBtn a={a} />
          </div>
        );
      })}
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

/** Detail card for a single stage. */
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
        {s.attention && <span className="badge cancelled"><Icon name="alert" size={12} />Attention</span>}
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
          {s.status !== 'skipped' && s.comments && (
            <div className={s.attention ? 'danger-text' : undefined}><Icon name={s.attention ? 'alert' : 'message'} size={13} /> {s.comments}</div>
          )}
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

// ---------------------------------------------------------------------------------------------------- side panels

function RequestActions({ d, onDone }: { d: Detail; onDone: (nd: Detail) => void }) {
  const meta = useMeta();
  const { can } = useAuth();
  const [dialog, setDialog] = useState<null | 'hold' | 'resume' | 'cancel' | 'reopen' | 'assign' | 'fast-close' | 'resolve-close'>(null);
  const [text, setText] = useState('');
  const [site, setSite] = useState(String(d.request.site_engineer_id ?? ''));
  const [eng, setEng] = useState(String(d.request.assigned_engineer_id ?? ''));
  const [closureCategory, setClosureCategory] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = d.request;
  const live = !['closed', 'cancelled'].includes(r.status);
  const canFastClose = live && r.status !== 'on_hold' && !['closed', 'completed'].includes(r.status) && can('request.manage');

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = dialog === 'assign' ? { site_engineer_id: site || null, assigned_engineer_id: eng || null }
        : dialog === 'resume' ? { comments: text }
        : dialog === 'fast-close' ? { reason: text, closure_category: closureCategory }
        : dialog === 'resolve-close' ? { reason: text, closure_category: 'Work Done' }
        : { reason: text };
      const endpoint = dialog === 'resolve-close' ? 'fast-close' : dialog;
      let result: Detail | undefined;
      for (const photo of [...photos]) {
        const fd = new FormData();
        fd.append('file', photo);
        fd.append('stage_key', 'closed');
        result = await api.post<Detail>(`/requests/${r.id}/attachments`, fd);
        setPhotos((prev) => prev.filter((p) => p !== photo));
      }
      result = await api.post<Detail>(`/requests/${r.id}/${endpoint}`, body);
      onDone(result);
      setDialog(null);
      setText('');
      setClosureCategory('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const titles = {
    hold: 'Put on hold', resume: 'Resume job card', cancel: 'Cancel job card',
    reopen: r.status === 'cancelled' ? 'Reinstate job card' : 'Reopen for rework', assign: 'Reassign engineers',
    'fast-close': 'Not needed — close job now', 'resolve-close': 'Resolved — close job now',
  };
  const confirmDisabled = busy
    || (dialog === 'fast-close' ? !text.trim() || !closureCategory
      : dialog === 'resolve-close' ? !text.trim() || !photos.length
      : dialog !== 'assign' && dialog !== 'resume' && !text.trim());

  return (
    <div className="card">
      <div className="card-head"><h3>Actions</h3></div>
      <div className="card-body row wrap">
        {live && r.status !== 'on_hold' && <button className="btn sm" onClick={() => setDialog('assign')}><Icon name="users" size={13} />Reassign</button>}
        {live && r.status !== 'on_hold' && <button className="btn sm" onClick={() => setDialog('hold')}><Icon name="pause" size={13} />Hold</button>}
        {r.status === 'on_hold' && <button className="btn sm primary" onClick={() => setDialog('resume')}><Icon name="play" size={13} />Resume</button>}
        {canFastClose && <button className="btn sm primary" onClick={() => setDialog('resolve-close')} title="Skip every remaining stage and close the job card as resolved"><Icon name="check" size={13} />Resolved — Close</button>}
        {canFastClose && <button className="btn sm ghost" onClick={() => setDialog('fast-close')} title="Skip every remaining stage and close the job card right now"><Icon name="skip" size={13} />Not Needed — Close</button>}
        {['closed', 'completed', 'cancelled'].includes(r.status) && <button className="btn sm" onClick={() => setDialog('reopen')}><Icon name="rotate" size={13} />{titles.reopen}</button>}
      </div>
      {dialog && (
        <Modal title={titles[dialog]} onClose={() => setDialog(null)} footer={<>
          <button className="btn" onClick={() => setDialog(null)}>Close</button>
          <button className={`btn ${dialog === 'cancel' ? 'danger' : 'primary'}`} disabled={confirmDisabled} onClick={run}>{busy ? 'Saving…' : 'Confirm'}</button>
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
          </> : dialog === 'fast-close' ? <>
            <div className="alert warn"><Icon name="alert" />This skips every remaining stage (Material, Permission, Work Started, Work Completed — whichever are still pending) and closes the job card immediately.</div>
            <Field label="Closure category" required>
              <select className="select" value={closureCategory} onChange={(e) => setClosureCategory(e.target.value)}>
                <option value="">Select…</option>{meta.closure_categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Reason" required>
              <textarea className="input" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
            </Field>
          </> : dialog === 'resolve-close' ? <>
            <div className="alert warn"><Icon name="alert" />This skips every remaining stage and closes the job card as resolved (Work Done).</div>
            <Field label="Remarks" required>
              <textarea className="input" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
            </Field>
            <Field label="Photo or video" required>
              <ImagePicker files={photos} onChange={setPhotos} max={50} accept="image/*,video/mp4,video/quicktime" maxMb={100} label="Upload photo/video" onError={setError} />
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

/**
 * Lets the coordinator/admin act on whichever stage is currently active, right from the app —
 * the same thing Slack's Yes/No buttons do for Site Visit, generalised to every stage, with a
 * remarks field always available.
 */
function CurrentStageAction({ d, onDone }: { d: Detail; onDone: (nd: Detail) => void }) {
  const meta = useMeta();
  const { can } = useAuth();
  const stage = d.stages.find((s) => s.status === 'active');
  const def = meta.stages.find((s) => s.key === stage?.stage_key);
  const [comments, setComments] = useState('');
  const [engineerId, setEngineerId] = useState(String(d.request.assigned_engineer_id ?? d.request.site_engineer_id ?? ''));
  const [closureCategory, setClosureCategory] = useState('');
  const [evidenceLink, setEvidenceLink] = useState('');
  const [evidenceFiles, setEvidenceFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!stage || !def || stage.stage_key === 'created') return null;
  const hasEvidence = d.attachments.some((a) => a.stage_key === stage.stage_key);
  const needsEngineer = stage.stage_key === 'work_started';
  const needsClosure = stage.stage_key === 'closed';
  const needsEvidence = !hasEvidence && !evidenceFiles.length;

  const addEvidenceLink = async () => {
    setBusy('evidence');
    setError(null);
    try { onDone(await api.post<Detail>(`/requests/${d.request.id}/attachments`, { url: evidenceLink, stage_key: stage.stage_key })); setEvidenceLink(''); }
    catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  };

  const pickEvidencePhotos = (files: File[]) => setEvidenceFiles(files);

  const act = async (kind: 'complete' | 'approve' | 'reject' | 'skip') => {
    setBusy(kind);
    setError(null);
    try {
      for (const file of [...evidenceFiles]) {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('stage_key', stage.stage_key);
        await api.post<Detail>(`/requests/${d.request.id}/attachments`, fd);
        setEvidenceFiles((prev) => prev.filter((f) => f !== file));
      }
      let result: Detail;
      if (kind === 'skip') {
        result = await api.post<Detail>(`/requests/${d.request.id}/stages/${stage.stage_key}/skip`, { reason: comments });
      } else if (kind === 'approve' || kind === 'reject') {
        result = await api.post<Detail>(`/requests/${d.request.id}/stages/${stage.stage_key}/decision`, {
          decision: kind === 'approve' ? 'approved' : 'rejected', comments, engineer_id: engineerId || undefined,
        });
      } else {
        result = await api.post<Detail>(`/requests/${d.request.id}/stages/${stage.stage_key}/complete`, {
          comments: comments || undefined,
          engineer_id: needsEngineer ? (engineerId || undefined) : undefined,
          closure_category: needsClosure ? closureCategory : undefined,
          closure_note: needsClosure ? (comments || undefined) : undefined,
        });
      }
      onDone(result);
      setComments('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const rejectNeedsReason = !comments.trim();
  const skipNeedsReason = !comments.trim();
  const closedNeedsCategory = needsClosure && !closureCategory;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head"><h3>Current Stage — {stage.name}</h3>{stage.attention && <span className="badge cancelled"><Icon name="alert" size={12} />Flagged on Slack</span>}</div>
      <div className="card-body stack">
        {stage.attention && stage.comments && <div className="alert warn"><Icon name="alert" />{stage.comments}</div>}
        <div className="form-grid">
          {needsEngineer && (
            <Field label="Engineer who did the work" required>
              <select className="select" value={engineerId} onChange={(e) => setEngineerId(e.target.value)}>
                <option value="">Select…</option>{meta.engineers.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </Field>
          )}
          {needsClosure && (
            <Field label="Closure category" required>
              <select className="select" value={closureCategory} onChange={(e) => setClosureCategory(e.target.value)}>
                <option value="">Select…</option>{meta.closure_categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Remarks" full required={def.decision}>
            <textarea className="input" style={{ minHeight: 60 }} placeholder="Notes for this stage (visible in the timeline)…" value={comments} onChange={(e) => setComments(e.target.value)} />
          </Field>
        </div>
        <div className={needsEvidence ? 'alert warn' : undefined}>
          {needsEvidence && <><Icon name="alert" />This stage needs evidence before it can be marked done.</>}
          <div className="stack" style={{ marginTop: needsEvidence ? 8 : 0, gap: 8 }}>
            <ImagePicker
              files={evidenceFiles} onChange={pickEvidencePhotos} max={50} onError={setError}
              accept={needsClosure ? 'image/*,video/mp4,video/quicktime' : 'image/*'} maxMb={needsClosure ? 100 : undefined}
              label={needsClosure ? 'Upload photo/video' : 'Upload photo'}
            />
            {busy === 'evidence' && <div className="muted small">Uploading…</div>}
            <div className="row">
              <input className="input" placeholder="…or paste a https:// photo / document link" value={evidenceLink} onChange={(e) => setEvidenceLink(e.target.value)} />
              <button className="btn sm" disabled={busy === 'evidence' || !/^https?:\/\//.test(evidenceLink)} onClick={addEvidenceLink}>Add link</button>
            </div>
          </div>
        </div>
        <div className="row wrap">
          {def.decision ? (
            <>
              <button className="btn sm primary" disabled={!!busy} onClick={() => act('approve')}><Icon name="check" size={13} />{busy === 'approve' ? 'Saving…' : 'Approve'}</button>
              <button className="btn sm danger" disabled={!!busy || rejectNeedsReason} title={rejectNeedsReason ? 'Remarks required to reject' : undefined} onClick={() => act('reject')}><Icon name="x" size={13} />{busy === 'reject' ? 'Saving…' : 'Reject'}</button>
            </>
          ) : (
            <button className="btn sm primary" disabled={!!busy || needsEvidence || (needsEngineer && !engineerId) || closedNeedsCategory} onClick={() => act('complete')}>
              <Icon name="check" size={13} />{busy === 'complete' ? 'Saving…' : 'Mark Done'}
            </button>
          )}
          {(def.optional || can('request.manage')) && (
            <button className="btn sm ghost" disabled={!!busy || skipNeedsReason} title={skipNeedsReason ? 'Remarks required to skip' : def.optional ? undefined : 'Mandatory stage — force-skip as coordinator/admin'} onClick={() => act('skip')}>
              <Icon name="skip" size={13} />{busy === 'skip' ? 'Saving…' : def.optional ? 'Skip (not needed)' : 'Force Skip'}
            </button>
          )}
        </div>
        <ErrorBox error={error} />
      </div>
    </div>
  );
}

function ClosurePhotosAdd({ d, onDone }: { d: Detail; onDone: (nd: Detail) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!files.length) return;
    setBusy(true);
    setError(null);
    try {
      let result: Detail | null = null;
      for (const file of [...files]) {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('stage_key', 'closed');
        result = await api.post<Detail>(`/requests/${d.request.id}/attachments`, fd);
        setFiles((prev) => prev.filter((f) => f !== file));
      }
      if (result) onDone(result);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      <ImagePicker files={files} onChange={setFiles} max={50} accept="image/*,video/mp4,video/quicktime" maxMb={100} label="Add photo/video" onError={setError} />
      {files.length > 0 && <button className="btn sm" disabled={busy} onClick={submit}>{busy ? 'Uploading…' : `Submit ${files.length} photo${files.length > 1 ? 's' : ''}`}</button>}
      <ErrorBox error={error} />
    </div>
  );
}

function ClosureNoteEdit({ d, onDone }: { d: Detail; onDone: (nd: Detail) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(d.request.closure_note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return (
      <div className="small">
        <span className="muted">Remarks:</span> {d.request.closure_note || <span className="muted">—</span>}{' '}
        <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => { setValue(d.request.closure_note ?? ''); setEditing(true); }}>✏️ Edit</button>
      </div>
    );
  }

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.post<Detail>(`/requests/${d.request.id}/closure-note`, { closure_note: value }));
      setEditing(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      <textarea className="input" style={{ minHeight: 60 }} value={value} onChange={(e) => setValue(e.target.value)} disabled={busy} />
      <div className="row">
        <button className="btn sm primary" disabled={busy || !value.trim()} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        <button className="btn sm" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
      </div>
      <ErrorBox error={error} />
    </div>
  );
}

function CommentBox({ d, onDone }: { d: Detail; onDone: (nd: Detail) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const post = async (kind: 'comment' | 'link') => {
    setBusy(true);
    setError(null);
    try {
      onDone(kind === 'comment'
        ? await api.post<Detail>(`/requests/${d.request.id}/comments`, { comment: text })
        : await api.post<Detail>(`/requests/${d.request.id}/attachments`, { url: link, source: 'comment' }));
      setText('');
      setLink('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const submitPhotos = async () => {
    if (!photos.length) return;
    setBusy(true);
    setError(null);
    try {
      let result: Detail | null = null;
      for (const file of [...photos]) {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('source', 'comment');
        result = await api.post<Detail>(`/requests/${d.request.id}/attachments`, fd);
        setPhotos((prev) => prev.filter((p) => p !== file));
      }
      if (result) onDone(result);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <div className="card-head"><h3>Add comment, photo or link</h3></div>
      <div className="card-body stack">
        <textarea className="input" style={{ minHeight: 60 }} placeholder="Write a comment…" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn sm" disabled={busy || !text.trim()} onClick={() => post('comment')}>Post comment</button>
        <ImagePicker files={photos} onChange={setPhotos} max={50} accept="image/*" label="Add photo" onError={setError} />
        {photos.length > 0 && <button className="btn sm" disabled={busy} onClick={submitPhotos}>{busy ? 'Uploading…' : `Submit ${photos.length} photo${photos.length > 1 ? 's' : ''}`}</button>}
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

// ---------------------------------------------------------------------------------------------------- stage strip (non-interactive summary)

function StageStripIcon({ s }: { s: Stage }) {
  if (s.status === 'completed') return <Icon name="check" size={12} />;
  if (s.status === 'rejected') return <Icon name="x" size={12} />;
  if (s.status === 'skipped') return <Icon name="skip" size={11} />;
  if (s.status === 'active') return <Icon name="clock" size={12} />;
  return null;
}

function StageStrip({ d }: { d: Detail }) {
  return (
    <div className="stage-strip">
      {d.stages.map((s) => (
        <div className={`stage-strip-item ${s.status}`} key={s.stage_key}>
          <span className="stage-strip-dot"><StageStripIcon s={s} /></span>
          <div className="stage-strip-name">{s.name}</div>
          <div className="stage-strip-status muted small">
            {s.status === 'active' ? (s.planned_at ? `Due ${fmtDateTime(s.planned_at)}` : 'IN PROGRESS') : cap(s.status).toUpperCase()}
          </div>
          {s.status === 'completed' && s.responsible_name && <div className="muted small">by {s.responsible_name}</div>}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------- page

type TabKey = 'overview' | 'materials' | 'approvals' | 'evidence' | 'communication' | 'closed' | 'history';

export function RequestDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data, error, loading, reload, setData } = useLoad(() => api.get<Detail>(`/requests/${id}`), [id]);
  const [editing, setEditing] = useState<Stage | null>(null);
  const [tab, setTab] = useState<TabKey>('overview');
  const [showRequester, setShowRequester] = useState(false);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;
  const r = data.request;
  const fact = (k: string, v: ReactNode) => <div className="fact"><div className="k">{k}</div><div className="v">{v ?? '—'}</div></div>;
  const locationImages = data.attachments.filter((a) => a.stage_key === 'created');
  const activeStage = data.stages.find((s) => s.status === 'active');
  const currentOwner = activeStage ? (activeStage.engineer_name ?? activeStage.responsible_name ?? activeStage.responsible_role) : null;
  const reopenCount = data.events.filter((e) => e.type === 'reopen').length;
  const delayResponsibility = r.is_overdue && activeStage ? (activeStage.responsible_name ?? activeStage.responsible_role ?? 'Unassigned') : 'NONE';
  const materialStages = data.stages.filter((s) => s.stage_key === 'material');
  const approvalStages = data.stages.filter((s) => s.stage_key === 'permission');
  const commentEvents = data.events.filter((e) => e.type === 'comment');

  const closurePhotos = data.attachments.filter((a) => a.stage_key === 'closed' && a.source !== 'comment');
  const tabDefs: { key: TabKey; label: string }[] = [
    { key: 'overview', label: 'Overview' }, { key: 'materials', label: 'Materials' },
    { key: 'approvals', label: 'Approvals' }, { key: 'evidence', label: 'Evidence' }, { key: 'communication', label: 'Comments' },
    ...(r.status === 'closed' ? [{ key: 'closed' as const, label: 'Closed' }] : []),
    { key: 'history', label: 'History' },
  ];
  const commentPhotos = data.attachments.filter((a) => a.source === 'comment');
  const evidenceAttachments = data.attachments.filter((a) => a.source !== 'comment' && a.stage_key !== 'closed');

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}><Link to="/job-cards" className="small">← Job Cards</Link></div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="job-head">
          <div className="grow">
            <div className="row wrap" style={{ alignItems: 'baseline', gap: 10 }}>
              <div className="no" style={{ fontSize: 17 }}>{r.request_no}</div>
              <StatusBadge status={r.status} />
            </div>
            <div className="muted small" style={{ marginTop: 4 }}>
              {r.property_name} — {r.location_detail || 'Not specified'} · {r.category_name} · {cap(r.priority)}
            </div>
          </div>
          <a className="btn sm" href={`/job-cards/${r.id}/print`} target="_blank" rel="noreferrer"><Icon name="download" size={14} />Job Card PDF</a>
        </div>
        {(r.hold_reason || r.cancel_reason) && (
          <div style={{ padding: '0 20px 14px' }}>
            <div className={`alert ${r.cancel_reason ? 'error' : 'warn'}`}><Icon name="alert" />{r.cancel_reason ? `Cancelled: ${r.cancel_reason}` : `On hold: ${r.hold_reason}`}</div>
          </div>
        )}
        <div className="facts">
          {fact('Current Owner', currentOwner)}
          {fact('Next Action', r.current_stage_name)}
          {fact('Next Action Due', fmtDateTime(r.current_stage_planned_at))}
          {fact('Target Completion', fmtDate(r.target_date))}
          {fact('Created', fmtDateTime(r.requested_at))}
          {fact(r.status === 'closed' ? 'Closed' : 'Completed', fmtDateTime(r.closed_at ?? r.completed_at))}
          {fact('Reopen Count', reopenCount)}
          {fact('Delay Responsibility', <span style={{ fontWeight: 700 }}>{delayResponsibility}</span>)}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><h3>Workflow Stages</h3></div>
        <div className="card-body flush"><StageStrip d={data} /></div>
      </div>

      {can('stage.update') && <CurrentStageAction d={data} onDone={setData} />}
      {can('request.manage') && <div style={{ marginBottom: 16 }}><RequestActions d={data} onDone={setData} /></div>}

      <Tabs tabs={tabDefs} value={tab} onChange={setTab} />

      {tab === 'overview' && (
        <div className="grid grid-sidebar">
          <div>
            <div className="card">
              <div className="card-head"><h3>Narration</h3></div>
              <div className="card-body stack">
                <div style={{ whiteSpace: 'pre-wrap' }}>{r.description ?? <span className="muted">No description</span>}</div>
                {r.reason && <div className="small"><span className="muted">Reason:</span> {r.reason}</div>}
                <Evidence items={locationImages} />
                {r.closure_note && <div className="small"><span className="muted">Closure note:</span> {r.closure_note}</div>}
              </div>
            </div>
          </div>
          <div className="stack">
            <div className="card">
              <div className="card-head">
                <h3>Requester</h3>
                <div className="actions"><button className="btn sm" onClick={() => setShowRequester(!showRequester)}>{showRequester ? 'Hide' : 'Show'}</button></div>
              </div>
              {showRequester && (
                <div className="card-body facts">
                  {fact('Name', r.requester_name)}
                  {fact('Email', r.requester_email)}
                  {fact('Contact', r.requester_contact)}
                  {fact('Property No.', r.property_no)}
                  {fact('Site engineer', r.site_engineer_name)}
                  {fact('Work engineer', r.engineer_name)}
                  {r.closure_category && fact('Closure', r.closure_category)}
                  {r.verified_by_name && fact('Verified by', r.verified_by_name)}
                </div>
              )}
            </div>
            {data.legacy && <LegacyRow legacy={data.legacy} />}
          </div>
        </div>
      )}

      {tab === 'materials' && (
        <div className="card">
          <div className="card-head"><h3>Material / Dependency</h3></div>
          <div className="card-body stack">
            {materialStages.length === 0 ? <Empty title="Not applicable to this job card" /> : materialStages.map((s) => (
              <StageDetail key={s.stage_key} d={data} stageKey={s.stage_key} onEdit={setEditing} canEdit={can('stage.edit_history')} />
            ))}
          </div>
        </div>
      )}

      {tab === 'approvals' && (
        <div className="card">
          <div className="card-head"><h3>Approvals</h3></div>
          <div className="card-body stack">
            {approvalStages.length === 0 ? <Empty title="No approval stages" /> : approvalStages.map((s) => (
              <StageDetail key={s.stage_key} d={data} stageKey={s.stage_key} onEdit={setEditing} canEdit={can('stage.edit_history')} />
            ))}
          </div>
        </div>
      )}

      {tab === 'evidence' && (
        <div className="card">
          <div className="card-head"><h3>Evidence & attachments</h3><span className="muted small">{evidenceAttachments.length}</span></div>
          <div className="card-body"><Evidence items={evidenceAttachments} /></div>
        </div>
      )}

      {tab === 'communication' && (
        <div className="stack">
          {commentPhotos.length > 0 && (
            <div className="card">
              <div className="card-head"><h3>Photos</h3><span className="muted small">{commentPhotos.length}</span></div>
              <div className="card-body"><Evidence items={commentPhotos} onDelete={can('request.comment') ? reload : undefined} /></div>
            </div>
          )}
          {can('request.comment') && <CommentBox d={data} onDone={setData} />}
          <div className="card">
            <div className="card-head"><h3>Comments</h3></div>
            {commentEvents.length === 0 ? <Empty title="No comments yet" /> : (
              <ul className="events">
                {commentEvents.map((e) => <li key={e.id}>{e.message}<div className="meta">{e.user_name} · {fmtDateTime(e.created_at)}</div></li>)}
              </ul>
            )}
          </div>
        </div>
      )}

      {tab === 'closed' && (
        <div className="card">
          <div className="card-head"><h3>Closing remarks & photos</h3></div>
          <div className="card-body stack">
            {r.closure_category && fact('Closure category', r.closure_category)}
            {can('request.manage') ? <ClosureNoteEdit d={data} onDone={setData} /> : (r.closure_note ? <div className="small"><span className="muted">Remarks:</span> {r.closure_note}</div> : <Empty title="No closing remarks" />)}
            <Evidence items={closurePhotos} />
            {can('request.comment') && <ClosurePhotosAdd d={data} onDone={setData} />}
          </div>
        </div>
      )}

      {tab === 'history' && (
        <div className="card">
          <div className="card-head"><h3>Activity</h3></div>
          {data.events.length === 0 ? <Empty title="No activity" /> : (
            <ul className="events">
              {data.events.map((e) => <li key={e.id}>{e.message}<div className="meta">{e.user_name} · {fmtDateTime(e.created_at)}</div></li>)}
            </ul>
          )}
        </div>
      )}

      {editing && <EditStageModal d={data} stage={editing} onClose={() => setEditing(null)} onDone={setData} />}
    </>
  );
}
