import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { EMPTY_JOB_CARD, JobCardForm, missingFields, toFormData, type JobCardValues } from '../components/JobCardForm';
import { JobCardTable } from '../components/RequestTable';
import { ErrorBox, Field, Loading, Modal, PageHead, Pager } from '../components/ui';
import { API_BASE, api, errorText, qs } from '../lib/api';
import { useAuth, useMeta } from '../lib/auth';
import { cap, SOURCE_LABEL } from '../lib/format';
import { useLoad, useUrlFilters } from '../lib/hooks';
import type { Paged, RequestRow } from '../lib/types';

/**
 * Saved views — shortcuts that the Status dropdown alone can't do (a combination of statuses,
 * a specific stage, or the overdue flag). Plain single-status views (In progress / On hold / Closed)
 * are left out here since the Status dropdown already does exactly that.
 */
const VIEWS: { key: string; label: string; filter: Record<string, string> }[] = [
  { key: '', label: 'All views', filter: {} },
  { key: 'open', label: 'Open jobs', filter: { status: 'active,on_hold' } },
  { key: 'overdue', label: 'Overdue', filter: { overdue: '1' } },
  { key: 'raised', label: 'Raised — awaiting approval', filter: { stage: 'triage', status: 'active' } },
  { key: 'approval', label: 'Waiting approval', filter: { stage: 'ph_discussion,permission', status: 'active' } },
  { key: 'material', label: 'Waiting material', filter: { stage: 'material', status: 'active' } },
  { key: 'verification', label: 'Verification pending', filter: { stage: 'verification,closed', status: 'active' } },
  { key: 'fms', label: 'Imported from FMS', filter: { source: 'fms_import' } },
];

const DEFAULTS = {
  view: '', q: '', property_id: '', category_id: '', status: '', stage: '', engineer_id: '', priority: '', from: '', to: '', overdue: '', source: '',
  page: '1', sort: 'requested_at', dir: 'desc',
};

/** Quick-count chips: each carries the exact filter combo that matches its dashboard KPI count. */
const CHIPS: { label: string; kpi: string; patch: Record<string, string> }[] = [
  { label: 'All', kpi: 'total', patch: { status: '', stage: '', overdue: '', view: '' } },
  { label: 'Open', kpi: 'open_jobs', patch: { status: 'active,on_hold', stage: '', overdue: '', view: '' } },
  { label: 'Overdue', kpi: 'overdue', patch: { status: '', stage: '', overdue: '1', view: '' } },
  { label: 'Waiting Approval', kpi: 'waiting_approval', patch: { status: 'active', stage: 'triage,ph_discussion,permission', overdue: '', view: '' } },
  { label: 'Waiting Material', kpi: 'waiting_material', patch: { status: 'active', stage: 'material', overdue: '', view: '' } },
  { label: 'In Progress', kpi: 'in_progress', patch: { status: 'in_progress', stage: '', overdue: '', view: '' } },
  { label: 'On Hold', kpi: 'on_hold', patch: { status: 'on_hold', stage: '', overdue: '', view: '' } },
  { label: 'Closed', kpi: 'closed', patch: { status: 'closed', stage: '', overdue: '', view: '' } },
];

export function JobCards() {
  const meta = useMeta();
  const { can } = useAuth();
  const f = useUrlFilters(DEFAULTS);
  const v = f.values;
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(v.q);
  const [more, setMore] = useState(['engineer_id', 'priority', 'from', 'to', 'source'].some((k) => v[k as keyof typeof v]));
  useEffect(() => setQ(v.q), [v.q]);
  useEffect(() => {
    const t = setTimeout(() => q !== v.q && f.set({ q }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const view = VIEWS.find((x) => x.key === v.view) ?? VIEWS[0];
  const query = { ...v, ...Object.fromEntries(Object.entries(view.filter).filter(([k]) => !v[k as keyof typeof v])), view: undefined };
  const { data, error, loading, reload } = useLoad(() => api.get<Paged<RequestRow>>('/requests', { ...query, page_size: 10 }), [f.key]);
  const { data: kpiData } = useLoad(() => api.get<{ kpi: Record<string, number> }>('/dashboard', query), [f.key]);
  const exportUrl = `${API_BASE}/requests/export.csv${qs({ ...query, page: undefined, sort: undefined, dir: undefined })}`;
  const showNew = params.get('new') === '1';
  const closeNew = () => { const n = new URLSearchParams(params); n.delete('new'); setParams(n, { replace: true }); };

  const sel = (key: keyof typeof DEFAULTS, label: string, options: { value: string | number; label: string }[]) => (
    <div className="f">
      <label htmlFor={`f-${key}`}>{label}</label>
      <select id={`f-${key}`} className="select" value={v[key]} onChange={(e) => f.set({ [key]: e.target.value })}>
        <option value="">All</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );

  return (
    <>
      <PageHead
        title="Job Cards"
        sub="Every job, from raised to closed."
        actions={<>
          <a className="btn" href={exportUrl}><Icon name="download" size={14} />CSV</a>
          {can('request.create') && <button className="btn primary" onClick={() => setParams({ ...Object.fromEntries(params), new: '1' })}><Icon name="plus" size={14} />New Job Card</button>}
        </>}
      />
      {kpiData && (
        <div className="row wrap" style={{ marginBottom: 16 }}>
          {CHIPS.map((c) => {
            const on = Object.entries(c.patch).every(([k, val]) => v[k as keyof typeof v] === val);
            return (
              <button key={c.label} className={`chip${on ? ' on' : ''}`} onClick={() => f.set(c.patch)}>
                {c.label} <b>{(kpiData.kpi[c.kpi] ?? 0).toLocaleString('en-IN')}</b>
              </button>
            );
          })}
        </div>
      )}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filters" style={{ borderRadius: 'var(--radius-lg)', borderBottom: more ? undefined : 0 }}>
          <div className="f search">
            <label htmlFor="f-q" className="sr-only">Search</label>
            <input id="f-q" className="input" placeholder="Search job card, property no. or description" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="f">
            <label htmlFor="f-view" className="sr-only">View</label>
            <select id="f-view" className="select" value={v.view} onChange={(e) => f.set({ view: e.target.value })}>
              {VIEWS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
            </select>
          </div>
          {sel('property_id', 'Project', meta.properties.map((p) => ({ value: p.id, label: p.name })))}
          {sel('status', 'Status', meta.statuses.map((s) => ({ value: s.key, label: s.label })))}
          {sel('category_id', 'Category', meta.categories.map((c) => ({ value: c.id, label: c.name })))}
          {sel('stage', 'Next Action', meta.stages.filter((s) => s.key !== 'created').map((s) => ({ value: s.key, label: s.name })))}
          <button className="btn ghost" onClick={() => setMore(!more)}>{more ? 'Fewer filters' : 'More filters'}</button>
          {Object.entries(v).some(([k, val]) => !['page', 'sort', 'dir'].includes(k) && val) && <button className="btn ghost" onClick={f.reset}>Clear</button>}
        </div>
        {more && (
          <div className="filters" style={{ borderRadius: '0 0 var(--radius-lg) var(--radius-lg)', background: 'var(--surface)' }}>
            {sel('engineer_id', 'Engineer', meta.engineers.map((e) => ({ value: e.id, label: e.name })))}
            {sel('priority', 'Priority', meta.priorities.map((p) => ({ value: p, label: cap(p) })))}
            {sel('source', 'Source', Object.entries(SOURCE_LABEL).map(([value, label]) => ({ value, label })))}
            <div className="f" style={{ minWidth: 130 }}><label>Raised from</label><input type="date" className="input" value={v.from} onChange={(e) => f.set({ from: e.target.value })} /></div>
            <div className="f" style={{ minWidth: 130 }}><label>Raised to</label><input type="date" className="input" value={v.to} onChange={(e) => f.set({ to: e.target.value })} /></div>
            <div className="f" style={{ minWidth: 'auto' }}><label>&nbsp;</label>
              <label className="check" style={{ height: 34 }}><input type="checkbox" checked={v.overdue === '1'} onChange={(e) => f.set({ overdue: e.target.checked ? '1' : '' })} />Overdue only</label>
            </div>
          </div>
        )}
      </div>
      <div className="card">
        <ErrorBox error={error} onRetry={reload} />
        {loading && !data ? <Loading /> : data && (
          <>
            <div style={{ opacity: loading ? 0.6 : 1 }}>
              <JobCardTable rows={data.rows} sort={{ sort: v.sort, dir: v.dir as 'asc' | 'desc' }} onSort={(s) => f.set({ sort: s.sort, dir: s.dir })} />
            </div>
            <Pager page={data.page} pageSize={data.page_size} total={data.total} onPage={(p) => f.set({ page: String(p) })} />
          </>
        )}
      </div>
      {showNew && <NewJobCardModal onClose={closeNew} />}
    </>
  );
}

function NewJobCardModal({ onClose }: { onClose: () => void }) {
  const meta = useMeta();
  const { user } = useAuth();
  const nav = useNavigate();
  const [value, setValue] = useState<JobCardValues>({ ...EMPTY_JOB_CARD, requester_name: user?.name ?? '' });
  const [priority, setPriority] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const missing = missingFields(value, images, { email: false });

  const submit = async () => {
    if (missing.length) return setError(`Please fill: ${missing.join(', ')}`);
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ id: number }>('/requests', toFormData(value, images, { priority }));
      nav(`/job-cards/${r.id}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Modal wide title="New Job Card" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Creating…' : 'Create Job Card'}</button>
    </>}>
      <div className="muted small">Raise a new job. It goes to the Process Coordinator for approval.</div>
      <JobCardForm value={value} onChange={setValue} images={images} onImages={setImages} onError={setError}
        options={{ properties: meta.properties, categories: meta.categories, work_types: meta.work_types }} />
      <Field label="Priority" help="Defaults to the work category's priority">
        <select className="select" style={{ maxWidth: 240 }} value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="">Category default</option>
          {meta.priorities.map((p) => <option key={p} value={p}>{cap(p)}</option>)}
        </select>
      </Field>
      <ErrorBox error={error} />
    </Modal>
  );
}
