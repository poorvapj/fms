import { useNavigate } from 'react-router-dom';
import { cap, fmtDateTime } from '../lib/format';
import type { RequestRow } from '../lib/types';
import { Empty, OverdueBadge, StatusBadge } from './ui';

export interface SortState { sort: string; dir: 'asc' | 'desc' }

function Th({ label, k, sort, onSort }: { label: string; k?: string; sort?: SortState; onSort?: (s: SortState) => void }) {
  if (!k || !sort || !onSort) return <th>{label}</th>;
  const on = sort.sort === k;
  return (
    <th className="sortable" onClick={() => onSort({ sort: k, dir: on && sort.dir === 'desc' ? 'asc' : 'desc' })} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      {label}{on ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  );
}

/** Job card list: Job Card · Project · Location · Category · Priority · Status · Engineer · Next Action · Due */
export function JobCardTable({ rows, sort, onSort, emptyText = 'No job cards match', compact }: {
  rows: RequestRow[]; sort?: SortState; onSort?: (s: SortState) => void; emptyText?: string; compact?: boolean;
}) {
  const nav = useNavigate();
  if (!rows.length) return <Empty title={emptyText} />;
  const closed = (r: RequestRow) => r.status === 'closed' || r.status === 'cancelled';
  return (
    <div className="table-wrap">
      <table className={`table${compact ? ' compact' : ''}`}>
        <thead>
          <tr>
            <Th label="Job Card" k="request_no" sort={sort} onSort={onSort} />
            <Th label="Project" k="property" sort={sort} onSort={onSort} />
            <th>Location</th>
            <Th label="Category" k="category" sort={sort} onSort={onSort} />
            {!compact && <Th label="Priority" k="priority" sort={sort} onSort={onSort} />}
            <Th label="Status" k="status" sort={sort} onSort={onSort} />
            <Th label="Engineer" k="engineer" sort={sort} onSort={onSort} />
            <th>Next Action</th>
            <Th label="Due" k="planned" sort={sort} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="clickable" onClick={() => nav(`/job-cards/${r.id}`)}>
              <td className="nowrap"><a href={`/job-cards/${r.id}`} onClick={(e) => { e.preventDefault(); nav(`/job-cards/${r.id}`); }} style={{ fontWeight: 600 }}>{r.request_no}</a></td>
              <td>{r.property_name}</td>
              <td className="title-cell">
                <div>{r.property_no || r.location_detail || <span className="muted">—</span>}</div>
                <div className="t muted small" title={r.title}>{r.title}</div>
              </td>
              <td>{r.category_name}</td>
              {!compact && <td>{cap(r.priority)}</td>}
              <td><StatusBadge status={r.status} /></td>
              <td>{r.engineer_name ?? r.site_engineer_name ?? <span className="muted">—</span>}</td>
              <td>{closed(r) ? <span className="muted">—</span> : r.current_stage_name}</td>
              <td className="nowrap small">
                {closed(r) || !r.current_stage_planned_at ? <span className="muted">—</span> : fmtDateTime(r.current_stage_planned_at)}
                {r.is_overdue && <div style={{ marginTop: 3 }}><OverdueBadge minutes={r.overdue_minutes} /></div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
