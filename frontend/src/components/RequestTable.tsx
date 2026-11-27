import type { MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from './Icon';
import { api, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
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

/**
 * Colour a row by what its remark says — mirrors the colour-coding used on the legacy FMS sheet
 * (red = not possible / rejected, orange = on hold / awaiting a decision). Green is reserved for
 * rows that are actually closed (by status, in rowTone) — a remark merely mentioning "done" doesn't
 * mean the row itself is closed, so it must never turn a still-open row green.
 */
function remarkTone(remark: string | null): { bg: string; text: string } | null {
  if (!remark) return null;
  const t = remark.toLowerCase();
  if (/not possible|not feasible|wrong complaint|rejected/.test(t)) return { bg: '#fca5a1', text: '#7a1712' };
  if (/hold|will decide|pending|requirement|dalegi|raised|driver pending/.test(t)) return { bg: '#fdba74', text: '#7a3b06' };
  return null;
}

const BAD_CLOSURE = /not feasible|wrong complaint|rejected/i;

/** Closed rows go green by status (not remark guesswork) — red only for a bad-outcome closure category.
 *  On-hold rows go orange by status too, since hold_reason doesn't flow through the legacy pc_remark text. */
function rowTone(r: RequestRow): { bg: string; text: string } | null {
  if (r.status === 'closed') return BAD_CLOSURE.test(r.closure_category ?? '') ? { bg: '#fca5a1', text: '#7a1712' } : { bg: '#86efac', text: '#0b4a24' };
  if (r.status === 'cancelled') return { bg: '#fca5a1', text: '#7a1712' };
  if (r.status === 'on_hold') return { bg: '#fdba74', text: '#7a3b06' };
  return remarkTone(r.pc_remark) ?? (r.is_overdue ? { bg: '#fdba74', text: '#7a3b06' } : null);
}

/** The legacy sheet's own reference number, when the imported remark text literally carries one —
 *  e.g. "Pending (FMS ref 2166)". import_row_no is just this row's position in whatever file it was
 *  imported from (often a fresh one-row/few-row batch), so it is NOT a real reference number. */
function fmsRef(remark: string | null): string | null {
  return /\(FMS ref (\d+)\)/.exec(remark ?? '')?.[1] ?? null;
}

/** Closed rows show the remark left at closing time; open rows keep the legacy FMS remark. Closing replaces
 *  the remark with our own closure_note, which drops the original FMS sheet reference — re-append it (if the
 *  sheet remark actually had one) so a closed card can still be traced back to the old sheet. */
function displayRemark(r: RequestRow): string | null {
  if (r.status === 'on_hold') return r.hold_reason || r.pc_remark;
  if (r.status !== 'closed') return r.pc_remark;
  const base = r.closure_note || r.pc_remark;
  const ref = fmsRef(r.pc_remark);
  if (!ref || base?.includes(`FMS ref ${ref}`)) return base;
  return base ? `${base} (FMS ref ${ref})` : `(FMS ref ${ref})`;
}

/** Job card list: Job Card · Project · Narration · Category · Priority · Status · Next Action · Due */
export function JobCardTable({ rows, sort, onSort, emptyText = 'No job cards match', compact, onUpdate }: {
  rows: RequestRow[]; sort?: SortState; onSort?: (s: SortState) => void; emptyText?: string; compact?: boolean; onUpdate?: () => void;
}) {
  const nav = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  if (!rows.length) return <Empty title={emptyText} />;
  const closed = (r: RequestRow) => r.status === 'closed' || r.status === 'cancelled';
  const remove = async (r: RequestRow, e: MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(`Permanently delete ${r.request_no}? This cannot be undone.`)) return;
    try {
      await api.del(`/requests/${r.id}`);
      onUpdate?.();
    } catch (err) {
      window.alert(errorText(err));
    }
  };
  return (
    <div className="table-wrap">
      <table className={`table${compact ? ' compact' : ''}`}>
        <thead>
          <tr>
            <Th label="Job Card" k="request_no" sort={sort} onSort={onSort} />
            <Th label="Project" k="property" sort={sort} onSort={onSort} />
            <th>Narration</th>
            <Th label="Category" k="category" sort={sort} onSort={onSort} />
            {!compact && <Th label="Priority" k="priority" sort={sort} onSort={onSort} />}
            <Th label="Status" k="status" sort={sort} onSort={onSort} />
            <th>Next Action</th>
            <Th label="Due" k="planned" sort={sort} onSort={onSort} />
            {!compact && <th>Remarks</th>}
            {isAdmin && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const tone = !compact ? rowTone(r) : null;
            return (
              <tr key={r.id} className="clickable" onClick={() => nav(`/job-cards/${r.id}`)} style={tone ? { background: tone.bg } : undefined}>
                <td className="nowrap"><a href={`/job-cards/${r.id}`} onClick={(e) => { e.preventDefault(); nav(`/job-cards/${r.id}`); }} style={{ fontWeight: 600 }}>{r.request_no}</a></td>
                <td>{r.property_name}</td>
                <td className="title-cell">
                  <div>{r.property_no || r.location_detail || <span className="muted">—</span>}</div>
                  <div className="t muted small" title={r.title}>{r.title}</div>
                </td>
                <td>{r.category_name}</td>
                {!compact && <td>{cap(r.priority)}</td>}
                <td><StatusBadge status={r.status} /></td>
                <td>{closed(r) ? <span className="muted">—</span> : r.current_stage_name}</td>
                <td className="nowrap small">
                  {closed(r) || !r.current_stage_planned_at ? <span className="muted">—</span> : fmtDateTime(r.current_stage_planned_at)}
                  {r.is_overdue && <div style={{ marginTop: 3 }}><OverdueBadge minutes={r.overdue_minutes} /></div>}
                </td>
                {!compact && (
                  <td className="small" style={tone ? { color: tone.text, fontWeight: 600 } : undefined}>
                    {displayRemark(r) || (closed(r) ? <span className="muted">—</span> : r.current_stage_comments ? r.current_stage_comments : r.current_stage_name ? `Pending at ${r.current_stage_name}` : <span className="muted">—</span>)}
                  </td>
                )}
                {isAdmin && (
                  <td className="right"><button className="btn sm ghost danger" title="Delete job card" onClick={(e) => remove(r, e)}><Icon name="trash" size={13} /></button></td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
