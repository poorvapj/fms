import { Link, useParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { ErrorBox, Loading, StageStatusBadge, StatusBadge } from '../components/ui';
import { api } from '../lib/api';
import { fmtDate, fmtDateTime } from '../lib/format';
import { useLoad } from '../lib/hooks';

interface Tracked {
  request_no: string; title: string; description: string; property: string; category: string; requested_at: string; target_date: string | null;
  status: string; current_stage: string | null; closure_category: string | null; closed_at: string | null; rejection_reason: string | null;
  stages: { name: string; status: string; actual_at: string | null }[];
}

export function TrackRequest() {
  const { token = '' } = useParams();
  const { data, error, loading } = useLoad(() => api.get<Tracked>(`/public/track/${encodeURIComponent(token)}`), [token]);
  return (
    <div className="public-wrap">
      <div className="public-card">
        <div className="public-brand"><span className="brand-mark"><Icon name="wrench" size={16} /></span>FMS Operations — Job Card Status</div>
        {loading && <Loading />}
        <ErrorBox error={error} />
        {data && (
          <div className="card">
            <div className="job-head">
              <div className="grow">
                <div className="no">{data.request_no}</div>
                <h1>{data.title}</h1>
                <div className="row wrap"><StatusBadge status={data.status} />{data.current_stage && <span className="muted">Current step: <b>{data.current_stage}</b></span>}</div>
              </div>
            </div>
            <div className="facts">
              <div className="fact"><div className="k">Property</div><div className="v">{data.property}</div></div>
              <div className="fact"><div className="k">Category</div><div className="v">{data.category}</div></div>
              <div className="fact"><div className="k">Raised</div><div className="v">{fmtDateTime(data.requested_at)}</div></div>
              <div className="fact"><div className="k">Required by</div><div className="v">{fmtDate(data.target_date)}</div></div>
            </div>
            <div className="card-body">
              {data.rejection_reason && <div className="alert error" style={{ marginBottom: 12 }}>{data.rejection_reason}</div>}
              {data.status === 'closed' && <div className="alert ok" style={{ marginBottom: 12 }}>Closed on {fmtDateTime(data.closed_at)}{data.closure_category ? ` — ${data.closure_category}` : ''}</div>}
              <table className="table compact">
                <thead><tr><th>Step</th><th>Status</th><th>Done at</th></tr></thead>
                <tbody>
                  {data.stages.map((s) => <tr key={s.name}><td>{s.name}</td><td><StageStatusBadge status={s.status} /></td><td className="small">{fmtDateTime(s.actual_at)}</td></tr>)}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <p className="muted small" style={{ textAlign: 'center', marginTop: 16 }}><Link to="/submit">Raise a new job card</Link></p>
      </div>
    </div>
  );
}
