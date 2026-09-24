import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading, PageHead, StatusBadge } from '../components/ui';
import { API_BASE, api, qs } from '../lib/api';
import { useMeta } from '../lib/auth';
import { fmtDate, fmtDateTime, fmtNumber } from '../lib/format';
import { useLoad, useUrlFilters } from '../lib/hooks';

interface Column { key: string; label: string; type?: string }
interface Report { key: string; title: string; description: string; date_basis: string; sections: { title: string; columns: Column[]; rows: Record<string, unknown>[] }[] }

function Cell({ col, row }: { col: Column; row: Record<string, unknown> }) {
  const v = row[col.key];
  switch (col.type) {
    case 'request': return <Link to={`/job-cards/${row.id}`} style={{ fontWeight: 600 }}>{String(v)}</Link>;
    case 'datetime': return <span className="nowrap">{fmtDateTime(v as string)}</span>;
    case 'date': return <span className="nowrap">{fmtDate(v as string)}</span>;
    case 'status': return v ? <StatusBadge status={String(v)} /> : null;
    case 'percent': return <>{v === null || v === undefined ? '—' : `${v}%`}</>;
    case 'number': case 'hours': return <>{fmtNumber(v)}</>;
    default: return <>{v === null || v === undefined || v === '' ? '—' : String(v)}</>;
  }
}

const PAGE = 300;

export function Reports() {
  const meta = useMeta();
  const { key = '' } = useParams();
  const nav = useNavigate();
  const f = useUrlFilters({ from: '', to: '', property_id: '', category_id: '', engineer_id: '' });
  const { data, error, loading, reload } = useLoad(() => (key ? api.get<Report>(`/reports/${key}`, f.values) : Promise.resolve(null)), [key, f.key]);

  if (!key) {
    return (
      <>
        <PageHead title="Reports" sub="Operational reports with CSV export. Click a report to view it on screen." />
        <div className="grid grid-2">
          {meta.reports.map((r) => (
            <div key={r.key} className="card">
              <div className="card-body report-card">
                <Link to={`/reports/${r.key}`} className="grow" style={{ color: 'inherit' }}>
                  <h3 style={{ fontSize: 15 }}>{r.title}</h3>
                  <div className="muted small" style={{ marginTop: 4 }}>{r.description}</div>
                </Link>
                <a className="btn sm" href={`${API_BASE}/reports/${r.key}?format=csv`}><Icon name="download" size={14} />CSV</a>
              </div>
            </div>
          ))}
        </div>
      </>
    );
  }

  const csv = `${API_BASE}/reports/${key}${qs({ ...f.values, format: 'csv' })}`;
  const sel = (k: keyof typeof f.values, label: string, opts: { id: number; name: string }[]) => (
    <div className="f"><label>{label}</label>
      <select className="select" value={f.values[k]} onChange={(e) => f.set({ [k]: e.target.value })}>
        <option value="">All</option>{opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>
  );

  return (
    <>
      <PageHead
        title={data?.title ?? meta.reports.find((r) => r.key === key)?.title ?? 'Report'}
        sub={data?.description}
        actions={<>
          <select className="select" style={{ width: 200 }} value={key} onChange={(e) => nav(`/reports/${e.target.value}${qs(f.values)}`)} aria-label="Report">
            {meta.reports.map((r) => <option key={r.key} value={r.key}>{r.title}</option>)}
          </select>
          <a className="btn" href={csv}><Icon name="download" size={14} />CSV</a>
        </>}
      />
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filters" style={{ borderRadius: 'var(--radius-lg)', borderBottom: 0 }}>
          <div className="f"><label>{data?.date_basis ?? 'Date'} from</label><input type="date" className="input" value={f.values.from} onChange={(e) => f.set({ from: e.target.value })} /></div>
          <div className="f"><label>to</label><input type="date" className="input" value={f.values.to} onChange={(e) => f.set({ to: e.target.value })} /></div>
          {sel('property_id', 'Property', meta.properties)}
          {sel('category_id', 'Category', meta.categories)}
          {sel('engineer_id', 'Engineer', meta.engineers)}
          <div className="f" style={{ minWidth: 'auto' }}><label>&nbsp;</label><button className="btn ghost" onClick={f.reset}>Clear</button></div>
        </div>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : data?.sections.map((s) => (
        <div className="card" key={s.title} style={{ marginBottom: 16, opacity: loading ? 0.6 : 1 }}>
          <div className="card-head"><h2>{s.title}</h2>{s.rows.length > PAGE && <span className="muted small">Showing first {PAGE} rows — export CSV for all</span>}</div>
          {!s.rows.length ? <Empty title="No data for these filters" /> : (
            <div className="table-wrap" style={{ maxHeight: 640, overflowY: 'auto' }}>
              <table className="table compact">
                <thead><tr>{s.columns.map((c) => <th key={c.key} className={['number', 'hours', 'percent'].includes(c.type ?? '') ? 'num' : ''}>{c.label}</th>)}</tr></thead>
                <tbody>
                  {s.rows.slice(0, PAGE).map((r, i) => (
                    <tr key={i}>{s.columns.map((c) => <td key={c.key} className={['number', 'hours', 'percent'].includes(c.type ?? '') ? 'num' : c.key === 'title' || c.key === 'description' ? 'title-cell' : ''}><Cell col={c} row={r} /></td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </>
  );
}
