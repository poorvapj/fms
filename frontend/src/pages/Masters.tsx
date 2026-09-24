import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MasterList } from './MasterList';
import { Icon } from '../components/Icon';
import { ErrorBox, Field, Loading, Modal, PageHead, Tabs } from '../components/ui';
import { api, errorText } from '../lib/api';
import { useAuth, useMeta } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import { useLoad, useUrlFilters } from '../lib/hooks';
import type { StageDef } from '../lib/types';

export function Masters() {
  const { can } = useAuth();
  const f = useUrlFilters({ tab: 'properties' });
  const tabs = [
    { key: 'properties', label: 'Properties' },
    { key: 'categories', label: 'Work Categories' },
    { key: 'engineers', label: 'Engineers' },
    { key: 'workflow', label: 'Workflow & SLA' },
    { key: 'closure', label: 'Closure Reasons' },
    ...(can('import.run') ? [{ key: 'import', label: 'Legacy FMS Import' }] : []),
  ];
  const t = f.values.tab;
  return (
    <>
      <PageHead title="Masters" sub="Properties, categories, engineers, workflow, SLA and legacy import." />
      <Tabs tabs={tabs} value={t} onChange={(k) => f.set({ tab: k })} />
      {t === 'properties' && <MasterList kind="properties" embedded key="p" />}
      {t === 'categories' && <MasterList kind="categories" embedded key="c" />}
      {t === 'engineers' && <MasterList kind="engineers" embedded key="e" />}
      {t === 'workflow' && <WorkflowSla />}
      {t === 'closure' && <ClosureCategories />}
      {t === 'import' && <ImportTab />}
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
