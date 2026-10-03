import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Field, Loading, Modal, PageHead, Tabs } from '../components/ui';
import { api, errorText } from '../lib/api';
import { useAuth, useMeta } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import { useLoad, useUrlFilters } from '../lib/hooks';
import type { StageDef } from '../lib/types';

export function Masters() {
  const { can } = useAuth();
  const f = useUrlFilters({ tab: 'org' });
  const tabs = [
    { key: 'org', label: 'Organization & Work' },
    { key: 'holidays', label: 'Holiday Calendar' },
    { key: 'workflow', label: 'Workflow Templates' },
    { key: 'sla', label: 'SLA Rules' },
    { key: 'escalation', label: 'Escalation Rules' },
    { key: 'reasons', label: 'Reasons' },
    ...(can('import.run') ? [{ key: 'import', label: 'Legacy Import' }] : []),
  ];
  const t = f.values.tab;
  return (
    <>
      <PageHead title="Masters" sub="Admin-only configuration: organization data, workflow, SLA, escalation, reasons and legacy import." />
      <Tabs tabs={tabs} value={t} onChange={(k) => f.set({ tab: k })} />
      {t === 'org' && <OrgWork />}
      {t === 'holidays' && <HolidayCalendar />}
      {t === 'workflow' && <WorkflowSla />}
      {t === 'sla' && <SlaRules />}
      {t === 'escalation' && <EscalationRules />}
      {t === 'reasons' && <Reasons />}
      {t === 'import' && <ImportTab />}
    </>
  );
}

/* ------------------------------------------------------------------ Organization & Work (tab 1) */

function ChipCard({ title, sub, items, onAdd, placeholder, readOnly, readOnlyNote }: {
  title: string; sub?: string; items: { key: string | number; label: string }[];
  onAdd?: (name: string) => Promise<void>; placeholder?: string; readOnly?: boolean; readOnlyNote?: string;
}) {
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!onAdd || !name.trim()) return;
    setBusy(true);
    try { await onAdd(name.trim()); setName(''); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <div className="card-head"><h2>{title}</h2></div>
      <div className="card-body stack">
        {sub && <div className="muted small">{sub}</div>}
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {items.map((i) => <span key={i.key} className="badge closed">{i.label}</span>)}
          {!items.length && <span className="muted small">None yet</span>}
        </div>
        {readOnly ? (
          <div className="muted small">{readOnlyNote}</div>
        ) : (
          <>
            <div className="row">
              <input className="input" placeholder={placeholder} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
              <button className="btn" disabled={busy || !name.trim()} onClick={add}>Add</button>
            </div>
            <ErrorBox error={err} />
          </>
        )}
      </div>
    </div>
  );
}

function OrgWork() {
  const meta = useMeta();
  const { refreshMeta } = useAuth();
  return (
    <div className="grid grid-2">
      <ChipCard
        title="Projects / Properties"
        sub="Sites and buildings where work is requested"
        items={meta.properties.filter((p) => p.active).map((p) => ({ key: p.id, label: p.name }))}
        placeholder="New project name"
        onAdd={async (name) => { await api.post('/masters/properties', { name, active: 1 }); await refreshMeta(); }}
      />
      <ChipCard
        title="Work Categories"
        sub="Trades / types of work"
        items={meta.categories.filter((c) => c.active).map((c) => ({ key: c.id, label: c.name }))}
        placeholder="New category name"
        onAdd={async (name) => { await api.post('/masters/categories', { name, active: 1 }); await refreshMeta(); }}
      />
      <ChipCard
        title="Job Types"
        items={meta.work_types.map((w) => ({ key: w.key, label: w.label }))}
        readOnly
        readOnlyNote="Job type is a fixed system classifier used by the public intake form (normalizeWorkType) and is not stored as an editable master in this build — changing these codes risks breaking existing job-card classification, so they are shown read-only here."
      />
      <ChipCard
        title="Priorities"
        items={meta.priorities.map((p, i) => ({ key: p, label: `${p[0].toUpperCase()}${p.slice(1)} (rank ${i + 1})` }))}
        readOnly
        readOnlyNote="Codes NEW_WORK, MATERIAL_REQUIRED and SIMPLE_REPAIR control which workflow template is selected. Priority rank order is embedded in SLA/sort logic (reports.ts PRIORITY_RANK, requests.ts buildFilter) — kept as a fixed enum here to avoid breaking those, rather than a dynamic master."
      />
    </div>
  );
}

/* ------------------------------------------------------------------ Holiday Calendar (tab 2) */

interface Holiday { id: number; date: string; name: string; property_id: number | null; recurring: boolean }

function HolidayCalendar() {
  const meta = useMeta();
  const { data, error, reload } = useLoad(() => api.get<Holiday[]>('/masters/holidays'), []);
  const [f, setF] = useState({ date: '', name: '', property_id: '', recurring: false });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!f.date || !f.name.trim()) return;
    setBusy(true);
    try {
      await api.post('/masters/holidays', { date: f.date, name: f.name.trim(), property_id: f.property_id ? Number(f.property_id) : null, recurring: f.recurring });
      setF({ date: '', name: '', property_id: '', recurring: false });
      reload();
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  const del = async (id: number) => { try { await api.del(`/masters/holidays/${id}`); reload(); } catch (e) { setErr(errorText(e)); } };
  const rows = [...(data ?? [])].sort((a, b) => (a.recurring ? a.date.slice(5) : a.date).localeCompare(b.recurring ? b.date.slice(5) : b.date));
  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <div className="card-head"><h2>Holiday calendar</h2><span className="muted small">Holidays are excluded from working-day SLA calculations (next working day / add working days / the triage deadline)</span></div>
      <div className="card-body stack">
        <div className="form-grid">
          <Field label="Date" required><input type="date" className="input" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label="Name" required><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Project (optional)" help="Leave as All projects for a company-wide holiday">
            <select className="select" value={f.property_id} onChange={(e) => setF({ ...f, property_id: e.target.value })}>
              <option value="">All projects</option>
              {meta.properties.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Repeats annually" help="For fixed-date holidays like Independence Day or Diwali — applies every year on this month/day">
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={f.recurring} onChange={(e) => setF({ ...f, recurring: e.target.checked })} />
              <span className="muted small">Repeat every year</span>
            </label>
          </Field>
        </div>
        <div><button className="btn primary" disabled={busy || !f.date || !f.name.trim()} onClick={add}>Add Holiday</button></div>
        <ErrorBox error={error ?? err} />
        <div className="stack" style={{ gap: 6 }}>
          {rows.map((h) => (
            <div key={h.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                <b>{h.name}</b> — {h.date} {h.recurring && <span className="badge">Yearly</span>}{' '}
                <span className="muted small">· {h.property_id ? (meta.properties.find((p) => p.id === h.property_id)?.name ?? `#${h.property_id}`) : 'All projects'}</span>
              </span>
              <button className="btn sm ghost" onClick={() => del(h.id)}><Icon name="x" size={13} />Remove</button>
            </div>
          ))}
          {!rows.length && <Empty title="No holidays configured" />}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ SLA Rules (tab 4) */

interface SlaRuleRow { id: number; scope: 'priority' | 'category' | 'property' | 'global'; scope_value: string | number | null; stage_key: string | null; hours: number }

function SlaRules() {
  const meta = useMeta();
  const { data, error, reload } = useLoad(() => api.get<SlaRuleRow[]>('/masters/sla-rules'), []);
  const [f, setF] = useState({ scope: 'global', scope_value: '', stage_key: '', hours: '48' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      await api.post('/masters/sla-rules', { scope: f.scope, scope_value: f.scope === 'global' ? null : f.scope_value, stage_key: f.stage_key || null, hours: Number(f.hours) });
      setF({ scope: 'global', scope_value: '', stage_key: '', hours: '48' });
      reload();
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  const del = async (id: number) => { try { await api.del(`/masters/sla-rules/${id}`); reload(); } catch (e) { setErr(errorText(e)); } };
  const describe = (r: SlaRuleRow) => {
    const scopeLabel = r.scope === 'global' ? 'Global' : r.scope === 'priority' ? `Priority: ${r.scope_value}` : r.scope === 'category' ? `Category: ${meta.categories.find((c) => c.id === Number(r.scope_value))?.name ?? r.scope_value}` : `Project: ${meta.properties.find((p) => p.id === Number(r.scope_value))?.name ?? r.scope_value}`;
    return `${scopeLabel}${r.stage_key ? ` · stage ${r.stage_key}` : ''}`;
  };
  return (
    <div className="card" style={{ maxWidth: 760 }}>
      <div className="card-head"><h2>SLA rules</h2><span className="muted small">Resolution order: Priority → Category → Project → Global → 48h fallback</span></div>
      <div className="card-body stack">
        <div className="muted small">
          This is an additional whole-job SLA override layer alongside the existing per-stage SLA rules in Workflow Templates. Rules here are fully persisted and readable via the API; they are not yet wired into live deadline computation (see TODO in backend/src/services/slaRules.ts) to avoid destabilising the per-stage engine every job card already depends on.
        </div>
        <div className="form-grid">
          <Field label="Scope" required>
            <select className="select" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value, scope_value: '' })}>
              <option value="global">Global</option>
              <option value="priority">Priority</option>
              <option value="category">Category</option>
              <option value="property">Project</option>
            </select>
          </Field>
          {f.scope !== 'global' && (
            <Field label="Scope value" required>
              {f.scope === 'priority' ? (
                <select className="select" value={f.scope_value} onChange={(e) => setF({ ...f, scope_value: e.target.value })}>
                  <option value="">Select…</option>
                  {meta.priorities.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              ) : f.scope === 'category' ? (
                <select className="select" value={f.scope_value} onChange={(e) => setF({ ...f, scope_value: e.target.value })}>
                  <option value="">Select…</option>
                  {meta.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              ) : (
                <select className="select" value={f.scope_value} onChange={(e) => setF({ ...f, scope_value: e.target.value })}>
                  <option value="">Select…</option>
                  {meta.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )}
            </Field>
          )}
          <Field label="Stage key (optional)" help="e.g. triage, site_visit — leave blank for the whole job">
            <input className="input" value={f.stage_key} onChange={(e) => setF({ ...f, stage_key: e.target.value })} />
          </Field>
          <Field label="Hours" required><input type="number" min={1} className="input" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} /></Field>
        </div>
        <div><button className="btn primary" disabled={busy} onClick={add}><Icon name="plus" size={14} />Add Rule</button></div>
        <ErrorBox error={error ?? err} />
        <div className="stack" style={{ gap: 6 }}>
          {(data ?? []).map((r) => (
            <div key={r.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span><span className="badge inferred">{r.scope}</span> {describe(r)} — <b>{r.hours}h</b></span>
              <button className="btn sm ghost" onClick={() => del(r.id)}><Icon name="x" size={13} />Remove</button>
            </div>
          ))}
          {!data?.length && <Empty title="No SLA rules configured" />}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Escalation Rules (tab 5) */

interface EscalationRuleRow { id: number; trigger: string; threshold_hours: number; escalate_to_role: string; active: boolean }
const TRIGGERS = ['APPROVAL_OVERDUE', 'MATERIAL_BLOCKED', 'NO_UPDATE', 'HOLD_STALE'];

function EscalationRules() {
  const meta = useMeta();
  const { data, error, reload } = useLoad(() => api.get<EscalationRuleRow[]>('/masters/escalation-rules'), []);
  const [f, setF] = useState({ trigger: TRIGGERS[0], threshold_hours: '48', escalate_to_role: 'coordinator' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      await api.post('/masters/escalation-rules', { trigger: f.trigger, threshold_hours: Number(f.threshold_hours), escalate_to_role: f.escalate_to_role });
      reload();
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  const toggle = async (r: EscalationRuleRow) => { try { await api.patch(`/masters/escalation-rules/${r.id}`, { active: !r.active }); reload(); } catch (e) { setErr(errorText(e)); } };
  const del = async (id: number) => { try { await api.del(`/masters/escalation-rules/${id}`); reload(); } catch (e) { setErr(errorText(e)); } };
  return (
    <div className="card" style={{ maxWidth: 760 }}>
      <div className="card-head"><h2>Escalation rules</h2></div>
      <div className="card-body stack">
        <div className="muted small">
          Wired into the Process Coordinator exception queue (backend/src/services/dashboard.ts coordinatorQueue): APPROVAL_OVERDUE's threshold now controls the "high severity" cutoff for overdue stages, and HOLD_STALE's threshold controls when an on-hold job is flagged as stale — replacing the previous hardcoded 48h / 3-day values. A documented default applies until an active rule exists for a trigger type.
        </div>
        <div className="form-grid">
          <Field label="Trigger" required>
            <select className="select" value={f.trigger} onChange={(e) => setF({ ...f, trigger: e.target.value })}>
              {TRIGGERS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Threshold (hrs)" required><input type="number" min={1} className="input" value={f.threshold_hours} onChange={(e) => setF({ ...f, threshold_hours: e.target.value })} /></Field>
          <Field label="Escalate to" required>
            <select className="select" value={f.escalate_to_role} onChange={(e) => setF({ ...f, escalate_to_role: e.target.value })}>
              {meta.roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </Field>
        </div>
        <div><button className="btn primary" disabled={busy} onClick={add}>Save Rule</button></div>
        <ErrorBox error={error ?? err} />
        <div className="stack" style={{ gap: 6 }}>
          {(data ?? []).map((r) => (
            <div key={r.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                <label className="check" style={{ display: 'inline-flex', marginRight: 8 }}><input type="checkbox" checked={r.active} onChange={() => toggle(r)} />Active</label>
                <span className="badge inferred">{r.trigger}</span> ≥ <b>{r.threshold_hours}h</b> → {meta.roles.find((x) => x.key === r.escalate_to_role)?.label ?? r.escalate_to_role}
              </span>
              <button className="btn sm ghost" onClick={() => del(r.id)}><Icon name="x" size={13} />Remove</button>
            </div>
          ))}
          {!data?.length && <Empty title="No escalation rules configured — documented defaults apply (48h / 72h)" />}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Reasons (tab 6) */

interface ReasonCode { id: number; kind: string; code: string; label: string; active: number }

function ReasonGroup({ title, kind }: { title: string; kind: string }) {
  const { data, error, reload } = useLoad(() => api.get<ReasonCode[]>('/masters/reason-codes', { kind }), [kind]);
  const [f, setF] = useState({ code: '', label: '' });
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    if (!f.code.trim() || !f.label.trim()) return;
    try { await api.post('/masters/reason-codes', { kind, code: f.code, label: f.label }); setF({ code: '', label: '' }); reload(); } catch (e) { setErr(errorText(e)); }
  };
  const toggle = async (r: ReasonCode) => { try { await api.patch(`/masters/reason-codes/${r.id}`, { active: r.active ? 0 : 1 }); reload(); } catch (e) { setErr(errorText(e)); } };
  return (
    <div className="card">
      <div className="card-head"><h2>{title}</h2></div>
      <div className="card-body stack">
        <ErrorBox error={error ?? err} />
        <div className="stack" style={{ gap: 4 }}>
          {(data ?? []).map((r) => (
            <div key={r.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span className={r.active ? '' : 'muted'}><span className="mono small">{r.code}</span> — {r.label}</span>
              <button className="btn sm ghost" onClick={() => toggle(r)}>{r.active ? 'Deactivate' : 'Activate'}</button>
            </div>
          ))}
          {!data?.length && <span className="muted small">None yet</span>}
        </div>
        <div className="row">
          <input className="input" placeholder="CODE" style={{ maxWidth: 160 }} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
          <input className="input" placeholder="Label" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
          <button className="btn" onClick={add}>Add</button>
        </div>
      </div>
    </div>
  );
}

function Reasons() {
  return (
    <>
      <div className="muted small" style={{ marginBottom: 12 }}>
        Hold, Cancellation and Reopen reasons remain free text in the hold/cancel/reopen dialogs (backend still accepts any text, unchanged) — these codes are offered as a quick-pick dropdown that fills the text field, so existing behaviour for live job cards is not broken. Closure reasons already have their own master (Closure Categories) and are surfaced below instead of a duplicate list.
      </div>
      <div className="grid grid-2">
        <ReasonGroup title="Hold Reasons" kind="hold" />
        <ClosureCategories />
        <ReasonGroup title="Cancellation Reasons" kind="cancel" />
        <ReasonGroup title="Reopen Reasons" kind="reopen" />
      </div>
    </>
  );
}

function ImportTab() {
  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <div className="card-body stack">
        <h2>Legacy FMS import</h2>
        <div className="muted">Import the old FMS sheet or a Google Form export (.tsv / .csv). The wizard previews, detects and maps columns, validates, then imports with full history. Re-importing the same sheet skips rows already imported.</div>
        <div className="row">
          <Link className="btn primary" to="/import"><Icon name="upload" size={14} />Start import wizard</Link>
          <Link className="btn" to="/import/history"><Icon name="history" size={14} />Import history</Link>
        </div>
      </div>
    </div>
  );
}

export function UsersPage() {
  return (
    <>
      <PageHead title="Users" sub="Logins, roles and engineer links" />
      <Users />
    </>
  );
}

function WorkflowSla() {
  const meta = useMeta();
  const { refreshMeta } = useAuth();
  const [edit, setEdit] = useState<StageDef | null>(null);
  return (
    <div className="card">
      <div className="card-head"><h2>Workflow stages</h2><span className="muted small">Working days exclude Sunday, as in the FMS sheet</span></div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>#</th><th>Stage</th><th>FMS stage</th><th>Responsible</th><th>Who can act</th><th>SLA</th><th>Evidence</th><th /></tr></thead>
          <tbody>
            {meta.stages.map((s) => (
              <tr key={s.key}>
                <td className="muted">{s.seq}</td>
                <td style={{ fontWeight: 600 }}>{s.name}{s.optional && <span className="badge inferred" style={{ marginLeft: 6 }}>optional</span>}{s.decision && <span className="badge inferred" style={{ marginLeft: 6 }}>approval</span>}</td>
                <td className="small muted">{s.legacy_name ?? '—'}</td>
                <td>{s.responsible_label}</td>
                <td className="small">{s.roles.map((r) => meta.roles.find((x) => x.key === r)?.label ?? r).join(', ') || '—'}</td>
                <td>{s.sla_text}</td>
                <td>{s.requires_evidence ? 'Required' : ''}</td>
                <td className="right">{s.key !== 'created' && <button className="btn sm ghost" onClick={() => setEdit(s)}><Icon name="edit" size={13} />Edit</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <SlaModal stage={edit} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await refreshMeta(); }} />}
    </div>
  );
}

function SlaModal({ stage, onClose, onSaved }: { stage: StageDef; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: stage.name, responsible_label: stage.responsible_label, requires_evidence: stage.requires_evidence,
    type: stage.sla.type, hours: String(stage.sla.hours ?? 4), days: String(stage.sla.days ?? 1), time: stage.sla.time ?? '18:00', anchor: stage.sla.anchor ?? 'previous',
  });
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await api.patch(`/workflow/stages/${stage.key}`, {
        name: f.name, responsible_label: f.responsible_label, requires_evidence: f.requires_evidence,
        sla: { type: f.type, hours: Number(f.hours), days: Number(f.days), time: f.time, anchor: f.anchor },
      });
      onSaved();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Modal title={`Stage — ${stage.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
      <div className="form-grid">
        <Field label="Display name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Responsible (label)"><input className="input" value={f.responsible_label} onChange={(e) => setF({ ...f, responsible_label: e.target.value })} /></Field>
        <Field label="SLA rule">
          <select className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            <option value="none">No SLA</option>
            <option value="add_hours">Add hours</option>
            <option value="same_day_at">Same day by time</option>
            <option value="next_day_at">Next working day by time</option>
            <option value="add_working_days">Add working days</option>
          </select>
        </Field>
        {f.type !== 'none' && (
          <Field label="Counted from">
            <select className="select" value={f.anchor} onChange={(e) => setF({ ...f, anchor: e.target.value })}>
              <option value="request">Request raised</option>
              <option value="previous">Previous stage completed</option>
            </select>
          </Field>
        )}
        {f.type === 'add_hours' && <Field label="Hours"><input type="number" min={1} className="input" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} /></Field>}
        {f.type === 'add_working_days' && <Field label="Working days"><input type="number" min={0} className="input" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></Field>}
        {(f.type === 'same_day_at' || f.type === 'next_day_at') && <Field label="By time"><input type="time" className="input" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></Field>}
      </div>
      <label className="check"><input type="checkbox" checked={f.requires_evidence} onChange={(e) => setF({ ...f, requires_evidence: e.target.checked })} />Evidence (photo / document) required to complete</label>
      <div className="muted small">New SLA rules apply to stages that become active from now on; historical planned dates are kept.</div>
      <ErrorBox error={error} />
    </Modal>
  );
}

function ClosureCategories() {
  const { refreshMeta } = useAuth();
  const { data, error, reload } = useLoad(() => api.get<{ id: number; name: string; active: number; sort: number }[]>('/masters/closure-categories'), []);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    try { await api.post('/masters/closure-categories', { name, sort: (data?.length ?? 0) + 1 }); setName(''); reload(); refreshMeta(); } catch (e) { setErr(errorText(e)); }
  };
  const toggle = async (c: { id: number; name: string; active: number; sort: number }) => {
    try { await api.patch(`/masters/closure-categories/${c.id}`, { ...c, active: c.active ? 0 : 1 }); reload(); refreshMeta(); } catch (e) { setErr(errorText(e)); }
  };
  return (
    <div className="card" style={{ maxWidth: 620 }}>
      <div className="card-head"><h2>Closure categories</h2></div>
      <ErrorBox error={error ?? err} />
      <table className="table">
        <tbody>
          {data?.map((c) => (
            <tr key={c.id}><td>{c.name}</td><td>{c.active ? <span className="badge closed">Active</span> : <span className="badge on_hold">Inactive</span>}</td><td className="right"><button className="btn sm ghost" onClick={() => toggle(c)}>{c.active ? 'Deactivate' : 'Activate'}</button></td></tr>
          ))}
        </tbody>
      </table>
      <div className="card-body row"><input className="input" placeholder="New category" value={name} onChange={(e) => setName(e.target.value)} /><button className="btn" disabled={!name.trim()} onClick={add}>Add</button></div>
    </div>
  );
}

interface UserRow { id: number; username: string; name: string; email: string | null; phone: string | null; role: string; engineer_id: number | null; engineer_name: string | null; active: number; last_login_at: string | null }

function Users() {
  const meta = useMeta();
  const { data, error, loading, reload } = useLoad(() => api.get<UserRow[]>('/users'), []);
  const [edit, setEdit] = useState<Partial<UserRow> | null>(null);
  return (
    <div className="card">
      <div className="card-head"><h2>Users</h2><div className="actions"><button className="btn primary sm" onClick={() => setEdit({ role: 'engineer', active: 1 })}><Icon name="plus" size={13} />Add user</button></div></div>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Engineer record</th><th>Last login</th><th>Status</th><th /></tr></thead>
            <tbody>
              {data?.map((u) => (
                <tr key={u.id}>
                  <td style={{ fontWeight: 600 }}>{u.name}</td>
                  <td className="mono">{u.username}</td>
                  <td>{meta.roles.find((r) => r.key === u.role)?.label ?? u.role}</td>
                  <td>{u.engineer_name ?? <span className="muted">—</span>}</td>
                  <td className="small">{fmtDateTime(u.last_login_at)}</td>
                  <td>{u.active ? <span className="badge closed">Active</span> : <span className="badge on_hold">Disabled</span>}</td>
                  <td className="right"><button className="btn sm ghost" onClick={() => setEdit(u)}><Icon name="edit" size={13} />Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <UserModal value={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function UserModal({ value, onClose, onSaved }: { value: Partial<UserRow>; onClose: () => void; onSaved: () => void }) {
  const meta = useMeta();
  const [f, setF] = useState<Record<string, string | number | null | undefined>>({ ...value, password: '' });
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try {
      const body = { ...f, engineer_id: f.engineer_id ? Number(f.engineer_id) : null, password: f.password || undefined };
      if (value.id) await api.patch(`/users/${value.id}`, body);
      else await api.post('/users', body);
      onSaved();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Modal title={value.id ? `Edit ${value.name}` : 'Add user'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
      <div className="form-grid">
        <Field label="Full name" required><input className="input" value={String(f.name ?? '')} onChange={set('name')} /></Field>
        <Field label="Username" required><input className="input" value={String(f.username ?? '')} onChange={set('username')} disabled={!!value.id} /></Field>
        <Field label="Role" required>
          <select className="select" value={String(f.role)} onChange={set('role')}>
            {meta.roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </Field>
        <Field label="Linked engineer" help={f.role === 'engineer' ? 'Required for engineer logins' : 'Optional'}>
          <select className="select" value={String(f.engineer_id ?? '')} onChange={set('engineer_id')}>
            <option value="">None</option>
            {meta.engineers.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </Field>
        <Field label="Email"><input className="input" value={String(f.email ?? '')} onChange={set('email')} /></Field>
        <Field label="Phone"><input className="input" value={String(f.phone ?? '')} onChange={set('phone')} /></Field>
        <Field label={value.id ? 'Reset password' : 'Temporary password'} required={!value.id} help="Min 8 characters with letters and numbers; user must change it at first login" full>
          <input className="input" type="password" autoComplete="new-password" value={String(f.password ?? '')} onChange={set('password')} />
        </Field>
      </div>
      {value.id && <label className="check"><input type="checkbox" checked={!!f.active} onChange={(e) => setF({ ...f, active: e.target.checked ? 1 : 0 })} />Active</label>}
      <ErrorBox error={error} />
    </Modal>
  );
}
