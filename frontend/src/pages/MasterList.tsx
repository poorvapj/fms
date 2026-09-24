import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Field, Loading, Modal, PageHead } from '../components/ui';
import { api, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cap } from '../lib/format';
import { useLoad } from '../lib/hooks';
import type { Master } from '../lib/types';

type Kind = 'properties' | 'categories' | 'engineers';

const CONFIG: Record<Kind, { title: string; singular: string; sub: string; filterKey: string; fields: { key: string; label: string; type?: 'priority' | 'bool' | 'int' }[] }> = {
  properties: { title: 'Properties', singular: 'property', sub: 'Sites and buildings where work is requested', filterKey: 'property_id', fields: [{ key: 'sort_order', label: 'Display order', type: 'int' }, { key: 'code', label: 'Code' }, { key: 'type', label: 'Type' }, { key: 'address', label: 'Address' }] },
  categories: { title: 'Work Categories', singular: 'category', sub: 'Trades / types of work, with default priority', filterKey: 'category_id', fields: [{ key: 'sort_order', label: 'Display order', type: 'int' }, { key: 'description', label: 'Description' }, { key: 'default_priority', label: 'Default priority', type: 'priority' }] },
  engineers: { title: 'Engineers', singular: 'engineer', sub: 'Site and work engineers; link a login in Masters → Users', filterKey: 'engineer_id', fields: [{ key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' }, { key: 'specialization', label: 'Specialisation' }, { key: 'is_external', label: 'External / vendor', type: 'bool' }] },
};

export function MasterList({ kind, embedded }: { kind: Kind; embedded?: boolean }) {
  const cfg = CONFIG[kind];
  const { refreshMeta } = useAuth();
  const { data, error, loading, reload } = useLoad(() => api.get<Master[]>(`/masters/${kind}`, { all: 1 }), [kind]);
  const [edit, setEdit] = useState<Partial<Master> | null>(null);
  const [merge, setMerge] = useState<Master | null>(null);
  const [q, setQ] = useState('');
  const after = () => { reload(); refreshMeta(); };
  const rows = (data ?? []).filter((r) => r.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      {embedded ? (
        <div className="row" style={{ marginBottom: 12 }}><span className="muted grow">{cfg.sub}</span><button className="btn primary" onClick={() => setEdit({ active: 1 })}><Icon name="plus" size={14} />Add {cfg.singular}</button></div>
      ) : <PageHead title={cfg.title} sub={cfg.sub} actions={<button className="btn primary" onClick={() => setEdit({ active: 1 })}><Icon name="plus" size={14} />Add {cfg.singular}</button>} />}
      <div className="card">
        <div className="filters"><div className="f search"><label>Search</label><input className="input" value={q} onChange={(e) => setQ(e.target.value)} /></div></div>
        <ErrorBox error={error} onRetry={reload} />
        {loading && !data ? <Loading /> : !rows.length ? <Empty /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th>{cfg.fields.map((f) => <th key={f.key}>{f.label}</th>)}{kind === 'engineers' && <th>Login</th>}<th className="num">Open</th><th className="num">Total job cards</th><th>Status</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.name}</td>
                    {cfg.fields.map((f) => <td key={f.key}>{f.type === 'bool' ? (r[f.key] ? 'Yes' : '') : f.type === 'priority' ? cap(String(r[f.key] ?? '')) : String(r[f.key] ?? '')}</td>)}
                    {kind === 'engineers' && <td className="small">{String(r.login_username ?? '') || <span className="muted">—</span>}</td>}
                    <td className="num"><Link to={`/job-cards?${cfg.filterKey}=${r.id}&view=open`}>{r.open_count}</Link></td>
                    <td className="num"><Link to={`/job-cards?${cfg.filterKey}=${r.id}`}>{r.request_count}</Link></td>
                    <td>{r.active ? <span className="badge closed">Active</span> : <span className="badge on_hold">Inactive</span>}</td>
                    <td className="right nowrap">
                      <button className="btn sm ghost" onClick={() => setEdit(r)}><Icon name="edit" size={13} />Edit</button>
                      <button className="btn sm ghost" onClick={() => setMerge(r)} title="Merge duplicate into another record"><Icon name="merge" size={13} />Merge</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {edit && <EditModal kind={kind} value={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); after(); }} />}
      {merge && <MergeModal kind={kind} source={merge} options={(data ?? []).filter((d) => d.id !== merge.id)} onClose={() => setMerge(null)} onDone={() => { setMerge(null); after(); }} />}
    </>
  );
}

function EditModal({ kind, value, onClose, onSaved }: { kind: Kind; value: Partial<Master>; onClose: () => void; onSaved: () => void }) {
  const cfg = CONFIG[kind];
  const [f, setF] = useState<Record<string, unknown>>({ ...value });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { name: f.name, active: f.active ? 1 : 0 };
      cfg.fields.forEach((x) => (body[x.key] = f[x.key] ?? (x.type === 'bool' ? 0 : x.type === 'int' ? 999 : '')));
      if (value.id) await api.patch(`/masters/${kind}/${value.id}`, body);
      else await api.post(`/masters/${kind}`, body);
      onSaved();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={value.id ? `Edit ${cfg.singular}` : `Add ${cfg.singular}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !String(f.name ?? '').trim()} onClick={save}>Save</button></>}>
      <Field label="Name" required><input className="input" value={String(f.name ?? '')} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
      {cfg.fields.map((x) => (
        <Field key={x.key} label={x.label} help={x.type === 'int' ? 'Lower numbers appear first in form dropdowns' : undefined}>
          {x.type === 'priority' ? (
            <select className="select" value={String(f[x.key] ?? 'medium')} onChange={(e) => setF({ ...f, [x.key]: e.target.value })}>
              {['low', 'medium', 'high', 'critical'].map((p) => <option key={p} value={p}>{cap(p)}</option>)}
            </select>
          ) : x.type === 'bool' ? (
            <label className="check"><input type="checkbox" checked={!!f[x.key]} onChange={(e) => setF({ ...f, [x.key]: e.target.checked ? 1 : 0 })} />Yes</label>
          ) : x.type === 'int' ? (
            <input type="number" min={0} className="input" style={{ maxWidth: 140 }} value={String(f[x.key] ?? 999)} onChange={(e) => setF({ ...f, [x.key]: e.target.value })} />
          ) : <input className="input" value={String(f[x.key] ?? '')} onChange={(e) => setF({ ...f, [x.key]: e.target.value })} />}
        </Field>
      ))}
      <label className="check"><input type="checkbox" checked={!!f.active} onChange={(e) => setF({ ...f, active: e.target.checked ? 1 : 0 })} />Active (available for new requests)</label>
      <ErrorBox error={error} />
    </Modal>
  );
}

function MergeModal({ kind, source, options, onClose, onDone }: { kind: Kind; source: Master; options: Master[]; onClose: () => void; onDone: () => void }) {
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await api.post(`/masters/${kind}/${source.id}/merge`, { target_id: Number(target) });
      onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={`Merge “${source.name}”`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn danger" disabled={busy || !target} onClick={run}>Merge</button></>}>
      <p style={{ margin: 0 }}>All {source.request_count} job card(s) referencing <b>{source.name}</b> will be moved to the record you choose, and <b>{source.name}</b> will be deleted. Use this to clean up duplicates or misspellings from the FMS sheet.</p>
      <Field label="Merge into" required>
        <select className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Select…</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </Field>
      <ErrorBox error={error} />
    </Modal>
  );
}
