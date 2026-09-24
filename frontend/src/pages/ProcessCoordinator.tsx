import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading, PageHead } from '../components/ui';
import { api } from '../lib/api';
import { fmtDuration } from '../lib/format';
import { useLoad, useUrlFilters } from '../lib/hooks';

interface Item { id: number; job_no: string; kind: string; severity: 'high' | 'medium' | 'low'; title: string; what: string; why: string; owner: string; late_minutes: number | null; action: string }
interface Queue { total: number; counts: Record<string, number>; items: Item[] }

const KINDS: Record<string, string> = {
  approval: 'Awaiting approval', no_engineer: 'No engineer', overdue: 'Overdue', assign: 'Assign engineer', inform: 'Inform requester',
  close: 'Ready to close', rejected: 'Rejected', hold: 'Long hold',
};

export function ProcessCoordinator() {
  const f = useUrlFilters({ kind: '' });
  const { data, error, loading, reload } = useLoad(() => api.get<Queue>('/coordinator/queue', f.values), [f.key]);
  return (
    <>
      <PageHead title="Process Coordinator" sub="Exception queue — every item explains what happened, why, who owns it, and what to do next." />
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : data && (
        <>
          <div className="row wrap" style={{ marginBottom: 14 }}>
            <button className={`chip${!f.values.kind ? ' on' : ''}`} onClick={() => f.set({ kind: '' })}>All <b>{data.total}</b></button>
            {Object.entries(KINDS).filter(([k]) => data.counts[k]).map(([k, label]) => (
              <button key={k} className={`chip${f.values.kind === k ? ' on' : ''}`} onClick={() => f.set({ kind: k })}>{label} <b>{data.counts[k]}</b></button>
            ))}
          </div>
          {!data.items.length ? <div className="card"><Empty title="Nothing needs attention">Every open job card is on track.</Empty></div> : (
            <div className="stack" style={{ gap: 10 }}>
              {data.items.map((i) => (
                <div key={`${i.id}-${i.kind}`} className="card exception">
                  <div className="exception-icon"><Icon name="shield" /></div>
                  <div className="grow">
                    <div className="row wrap"><h3>{i.title}</h3><span className={`sev ${i.severity}`}>{i.severity.toUpperCase()}</span></div>
                    <div className="small"><span className="muted">What happened:</span> {i.what}</div>
                    <div className="small"><span className="muted">Why flagged:</span> {i.why}</div>
                    <div className="small"><span className="muted">Current owner:</span> {i.owner}{i.late_minutes ? <> · <span className="late-text">{fmtDuration(i.late_minutes)} late</span></> : null}</div>
                    <div className="small next-action">{i.action}</div>
                  </div>
                  <Link className="btn sm" to={`/job-cards/${i.id}`}>Open Job Card</Link>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
