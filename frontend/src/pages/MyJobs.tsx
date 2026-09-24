import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { ErrorBox, Loading, OverdueBadge, PageHead, StatusBadge } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import { useLoad } from '../lib/hooks';
import type { RequestRow } from '../lib/types';

interface Board { overdue: RequestRow[]; today: RequestRow[]; blocked: RequestRow[]; upcoming: RequestRow[] }

function JobList({ title, rows, empty }: { title: string; rows: RequestRow[]; empty: string }) {
  return (
    <div className="card">
      <div className="card-head"><h2>{title} ({rows.length})</h2></div>
      <div className="card-body">
        {!rows.length ? (
          <div className="empty" style={{ border: '1px dashed var(--border)', borderRadius: 'var(--radius)' }}>
            <Icon name="inbox" size={26} />
            <div style={{ fontWeight: 600, color: 'var(--text)', marginTop: 8 }}>All clear</div>
            <div className="small">{empty}</div>
          </div>
        ) : (
          <ul className="job-list">
            {rows.slice(0, 50).map((r) => (
              <li key={r.id}>
                <Link to={`/job-cards/${r.id}`} className="job-item">
                  <div className="row wrap">
                    <b>{r.request_no}</b>
                    <StatusBadge status={r.status} />
                    {r.is_overdue && <OverdueBadge minutes={r.overdue_minutes} />}
                  </div>
                  <div className="small">{r.property_name}{r.property_no ? ` · ${r.property_no}` : ''} · {r.category_name}</div>
                  <div className="small muted t">{r.title}</div>
                  <div className="small">Next: <b>{r.current_stage_name}</b>{r.current_stage_planned_at ? ` · due ${fmtDateTime(r.current_stage_planned_at)}` : ''}</div>
                </Link>
              </li>
            ))}
            {rows.length > 50 && <li className="muted small">+ {rows.length - 50} more — see Job Cards</li>}
          </ul>
        )}
      </div>
    </div>
  );
}

export function MyJobs() {
  const { user } = useAuth();
  const { data, error, loading, reload } = useLoad(() => api.get<Board>('/my-jobs'), []);
  return (
    <>
      <PageHead title="My Jobs" sub="What you need to do next — nothing else." />
      {user?.role === 'engineer' && !user.engineer_id && <div className="alert warn" style={{ marginBottom: 16 }}>Your login is not linked to an engineer record. Ask an administrator to link it in Users.</div>}
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : data && (
        <div className="grid grid-2">
          <JobList title="Overdue" rows={data.overdue} empty="Nothing overdue — good work." />
          <JobList title="Today" rows={data.today} empty="Nothing due today." />
          <JobList title="Blocked" rows={data.blocked} empty="No jobs are blocked on material / approval / hold." />
          <JobList title="Upcoming" rows={data.upcoming} empty="No other open jobs assigned to you." />
        </div>
      )}
    </>
  );
}
