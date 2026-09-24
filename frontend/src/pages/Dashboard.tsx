import { Link } from 'react-router-dom';
import { ErrorBox, Kpi, Loading, PageHead } from '../components/ui';
import { api, qs } from '../lib/api';
import { useMeta } from '../lib/auth';
import { useLoad, useUrlFilters } from '../lib/hooks';

interface HealthRow { id: number | null; name: string; open: number; overdue: number; due_today: number; waiting_material: number; waiting_approval: number; closed: number; reopened: number; reopen_rate: number }
interface DashData { kpi: Record<string, number>; health: HealthRow[]; group_by: string }

const GROUPS = [
  { key: 'property', label: 'Project', filter: 'property_id' },
  { key: 'category', label: 'Category', filter: 'category_id' },
  { key: 'engineer', label: 'Engineer', filter: 'engineer_id' },
];

const STATUS_FILTERS: { key: string; label: string; test: (r: HealthRow) => boolean }[] = [
  { key: '', label: 'All', test: () => true },
  { key: 'has_open', label: 'Has open jobs', test: (r) => r.open > 0 },
  { key: 'has_overdue', label: 'Has overdue', test: (r) => r.overdue > 0 },
  { key: 'has_material', label: 'Waiting material', test: (r) => r.waiting_material > 0 },
  { key: 'has_approval', label: 'Waiting approval', test: (r) => r.waiting_approval > 0 },
  { key: 'none_open', label: 'No open jobs', test: (r) => r.open === 0 },
];

export function Dashboard() {
  const meta = useMeta();
  const f = useUrlFilters({ property_id: '', group_by: 'property', q: '', status: '' });
  const { data, error, loading, reload } = useLoad(() => api.get<DashData>('/dashboard', f.values), [f.key]);
  const base = { property_id: f.values.property_id };
  const link = (extra: Record<string, string>) => `/job-cards${qs({ ...base, ...extra })}`;
  const group = GROUPS.find((g) => g.key === f.values.group_by) ?? GROUPS[0];
  const k = data?.kpi;
  const statusFilter = STATUS_FILTERS.find((s) => s.key === f.values.status) ?? STATUS_FILTERS[0];
  const rows = (data?.health ?? []).filter((r) => r.name.toLowerCase().includes(f.values.q.trim().toLowerCase()) && statusFilter.test(r));

  return (
    <>
      <PageHead
        title="Dashboard"
        sub="Everything that needs attention, at a glance."
        actions={
          <select className="select" style={{ width: 220 }} value={f.values.property_id} onChange={(e) => f.set({ property_id: e.target.value })} aria-label="Property">
            <option value="">All properties</option>
            {meta.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        }
      />
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data && <Loading />}
      {k && data && (
        <>
          <div className="kpis kpis-5">
            <Kpi label="Open Jobs" value={k.open_jobs} to={link({ view: 'open' })} hint="Not closed or cancelled" />
            <Kpi label="Due Today" value={k.due_today} to={link({ view: 'open', sort: 'planned', dir: 'asc' })} hint="Next action due today" tone="info" />
            <Kpi label="Overdue" value={k.overdue} to={link({ view: 'overdue' })} hint="Next action past due" tone="bad" />
            <Kpi label="Waiting Material" value={k.waiting_material} to={link({ view: 'material' })} tone="warn" />
            <Kpi label="Waiting Approval" value={k.waiting_approval} to={link({ view: 'approval' })} hint="Triage, Project Head, Permission" tone="warn" />
            <Kpi label="In Progress" value={k.in_progress} to={link({ view: 'in_progress' })} hint="Site visit or work under way" />
            <Kpi label="Verification Pending" value={k.verification_pending} to={link({ view: 'verification' })} hint="Work done, not yet closed" tone="info" />
            <Kpi label="Closed (30d)" value={k.closed_30d} to={link({ view: 'closed' })} hint={`${k.closed.toLocaleString('en-IN')} closed in total`} tone="good" />
            <Kpi label="Reopened" value={k.reopened} hint="Closed jobs reopened for rework" tone="bad" />
            <Kpi label="On Hold" value={k.on_hold} to={link({ view: 'on_hold' })} hint="Included in Open Jobs" />
          </div>

          <div className="card">
            <div className="card-head">
              <h2>{group.label} Health</h2>
              <div className="actions">
                <div className="seg">
                  {GROUPS.map((g) => <button key={g.key} className={g.key === group.key ? 'on' : ''} onClick={() => f.set({ group_by: g.key })}>{g.label}</button>)}
                </div>
              </div>
            </div>
            <div className="filters" style={{ borderRadius: 0 }}>
              <div className="f search">
                <label htmlFor="dh-q">Search {group.label.toLowerCase()}</label>
                <input id="dh-q" className="input" placeholder={`Search ${group.label.toLowerCase()} name…`} value={f.values.q} onChange={(e) => f.set({ q: e.target.value })} />
              </div>
              <div className="f">
                <label htmlFor="dh-status">Status</label>
                <select id="dh-status" className="select" value={f.values.status} onChange={(e) => f.set({ status: e.target.value })}>
                  {STATUS_FILTERS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </div>
              {(f.values.q || f.values.status) && <button className="btn ghost" onClick={() => f.set({ q: '', status: '' })}>Clear</button>}
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{group.label}</th><th className="num">Open</th><th className="num">Overdue</th><th className="num">Due today</th>
                    <th className="num">Waiting material</th><th className="num">Waiting approval</th><th className="num">Closed</th><th className="num">Reopen rate</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={8} className="empty" style={{ padding: 24 }}>No {group.label.toLowerCase()}s match this filter.</td></tr>
                  )}
                  {rows.map((r) => {
                    const to = (extra: Record<string, string>) => (r.id ? link({ [group.filter]: String(r.id), ...extra }) : undefined);
                    const cell = (n: number, extra: Record<string, string>, cls = '') => {
                      const href = to(extra);
                      return <td className={`num ${n ? cls : ''}`}>{n && href ? <Link to={href} className={cls}>{n.toLocaleString('en-IN')}</Link> : n.toLocaleString('en-IN')}</td>;
                    };
                    return (
                      <tr key={r.name}>
                        <td style={{ fontWeight: 500 }}>{r.name}</td>
                        {cell(r.open, { view: 'open' })}
                        {cell(r.overdue, { view: 'overdue' }, 'late-text')}
                        {cell(r.due_today, { view: 'open' })}
                        {cell(r.waiting_material, { view: 'material' })}
                        {cell(r.waiting_approval, { view: 'approval' })}
                        {cell(r.closed, { view: 'closed' })}
                        <td className="num">{r.reopen_rate}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
