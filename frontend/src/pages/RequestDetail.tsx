import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Field, Loading, Modal, StageStatusBadge, StatusBadge, Tabs } from '../components/ui';
import { API_BASE, api, errorText } from '../lib/api';
import { useAuth, useMeta } from '../lib/auth';
import { cap, fmtBytes, fmtDate, fmtDateTime, fmtDuration } from '../lib/format';
import { useLoad } from '../lib/hooks';
import type { Attachment, RequestDetail as Detail, Stage } from '../lib/types';

// ---------------------------------------------------------------------------------------------------- helpers

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
      <div className="card-head"><h3>Actions</h3></div>
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
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------- page

type TabKey = 'overview' | 'materials' | 'approvals' | 'evidence' | 'communication' | 'history';

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
  const otherFiles = data.attachments.filter((a) => a.stage_key !== 'created');
  const activeStage = data.stages.find((s) => s.status === 'active');
  const currentOwner = activeStage ? (activeStage.engineer_name ?? activeStage.responsible_name ?? activeStage.responsible_role) : null;
  const reopenCount = data.events.filter((e) => e.type === 'reopen').length;
  const delayResponsibility = r.is_overdue && activeStage ? (activeStage.responsible_name ?? activeStage.responsible_role ?? 'Unassigned') : 'NONE';
  const materialStages = data.stages.filter((s) => ['material', 'permission'].includes(s.stage_key));
  const approvalStages = data.stages.filter((s) => s.decision_stage);
  const commentEvents = data.events.filter((e) => e.type === 'comment');

  const tabDefs: { key: TabKey; label: string }[] = [
    { key: 'overview', label: 'Overview' }, { key: 'materials', label: 'Materials' },
    { key: 'approvals', label: 'Approvals' }, { key: 'evidence', label: 'Evidence' }, { key: 'communication', label: 'Communication' }, { key: 'history', label: 'History' },
  ];

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
          <div className="card-head"><h3>Materials / Dependency & Permission</h3></div>
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
          <div className="card-head"><h3>Evidence & attachments</h3><span className="muted small">{data.attachments.length}</span></div>
          <div className="card-body"><Evidence items={data.attachments} /></div>
        </div>
      )}

      {tab === 'communication' && (
        <div className="stack">
          {can('request.comment') && <CommentBox d={data} onDone={setData} />}
          <div className="card">
            <div className="card-head"><h3>Comments</h3></div>
            {commentEvents.length === 0 ? <Empty title="No comments yet" /> : (
              <ul className="events">
                {commentEvents.map((e) => <li key={e.id}>{e.message}<div className="meta">{e.user_name} · {fmtDateTime(e.created_at)}</div></li>)}
              </ul>
            )}
          </div>
          {otherFiles.length > 0 && (
            <div className="card">
              <div className="card-head"><h3>Shared files & links</h3></div>
              <div className="card-body"><Evidence items={otherFiles} /></div>
            </div>
          )}
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
