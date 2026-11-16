import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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

/** Inline "resolve / hold" shortcut for a row, so the coordinator doesn't have to open the job card. */
function QuickAction({ row, onDone }: { row: RequestRow; onDone: () => void }) {
  const [kind, setKind] = useState<'' | 'resolved' | 'not_needed' | 'hold'>('');
  const [remarks, setRemarks] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = !['closed', 'cancelled'].includes(row.status);
  if (!live) return <ClosedRemarkEdit row={row} onDone={onDone} />;

  const apply = async () => {
    if (!kind || !remarks.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === 'resolved') {
        await api.post(`/requests/${row.id}/fast-close`, { reason: remarks, closure_category: 'Work Done' });
        for (const photo of photos) {
          const fd = new FormData();
          fd.append('file', photo);
          fd.append('stage_key', 'closed');
          await api.post(`/requests/${row.id}/attachments`, fd);
        }
      } else if (kind === 'not_needed') await api.post(`/requests/${row.id}/fast-close`, { reason: remarks, closure_category: 'Not Feasible' });
      else await api.post(`/requests/${row.id}/hold`, { reason: remarks });
      setKind('');
      setRemarks('');
      setPhotos([]);
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const kindColor = ({ resolved: 'var(--good)', not_needed: 'var(--bad)', hold: 'var(--warn)' } as Record<string, string>)[kind];

  return (
    <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
      <select
        className="select" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} disabled={busy}
        style={{ width: 100, height: 30, ...(kindColor ? { borderColor: kindColor, color: kindColor, fontWeight: 600 } : {}) }}
      >
        <option value="">Select…</option>
        <option value="resolved">Resolved</option>
        <option value="not_needed">Not Needed</option>
        <option value="hold">Hold</option>
      </select>
      <input className="input" placeholder="Remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} disabled={busy} style={{ width: 110, height: 30 }} title={error ?? undefined} />
      {kind === 'resolved' && (
        <label className="btn sm" title={photos.length ? photos.map((p) => p.name).join(', ') : 'Attach completion photo(s)'} style={{ cursor: 'pointer' }}>
          {photos.length ? `📷✓${photos.length}` : '📷'}
          <input type="file" accept="image/*" multiple hidden onChange={(e) => setPhotos(Array.from(e.target.files ?? []))} disabled={busy} />
        </label>
      )}
      <button className="btn sm" disabled={busy || !kind || !remarks.trim()} onClick={apply} title={error ?? 'Apply'}>{busy ? '…' : 'Go'}</button>
    </div>
  );
}

/** Closed rows: the Resolve/Hold cell becomes a small editor for the remark left at close time. */
function ClosedRemarkEdit({ row, onDone }: { row: RequestRow; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.closure_note ?? row.pc_remark ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (row.status !== 'closed') return <span className="muted small">—</span>;

  if (!editing) {
    return (
      <button
        className="btn sm" title="Edit closing remarks"
        onClick={(e) => { e.stopPropagation(); setValue(row.closure_note ?? row.pc_remark ?? ''); setEditing(true); }}
      >
        ✏️ Edit
      </button>
    );
  }

  const save = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/requests/${row.id}/closure-note`, { closure_note: value });
      setEditing(false);
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
      <input className="input" value={value} onChange={(e) => setValue(e.target.value)} disabled={busy} style={{ width: 150, height: 30 }} title={error ?? undefined} />
      <button className="btn sm" disabled={busy || !value.trim()} onClick={save} title={error ?? 'Save'}>{busy ? '…' : 'Save'}</button>
      <button className="btn sm" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
    </div>
  );
}

/**
 * Colour a row by what its remark says — mirrors the colour-coding used on the legacy FMS sheet
 * (green = done, red = not possible / rejected, orange = on hold / awaiting a decision).
 */
function remarkTone(remark: string | null): { bg: string; text: string } | null {
  if (!remark) return null;
  const t = remark.toLowerCase();
  if (/not possible|not feasible|wrong complaint|rejected/.test(t)) return { bg: '#fca5a1', text: '#7a1712' };
  if (/\bdone\b|resolved|work done|completed|fixed/.test(t)) return { bg: '#86efac', text: '#0b4a24' };
  if (/hold|will decide|pending|requirement|dalegi|raised|driver pending/.test(t)) return { bg: '#fdba74', text: '#7a3b06' };
  return null;
}

const BAD_CLOSURE = /not feasible|wrong complaint|rejected/i;

/** Closed rows go green by status (not remark guesswork) — red only for a bad-outcome closure category. */
function rowTone(r: RequestRow): { bg: string; text: string } | null {
  if (r.status === 'closed') return BAD_CLOSURE.test(r.closure_category ?? '') ? { bg: '#fca5a1', text: '#7a1712' } : { bg: '#86efac', text: '#0b4a24' };
  return remarkTone(r.pc_remark);
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
  const { can } = useAuth();
  if (!rows.length) return <Empty title={emptyText} />;
  const closed = (r: RequestRow) => r.status === 'closed' || r.status === 'cancelled';
  const showQuickAction = !compact && onUpdate && can('request.manage');
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
            {showQuickAction && <th>Resolve / Hold</th>}
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
                    {displayRemark(r) || <span className="muted">—</span>}
                  </td>
                )}
                {showQuickAction && <td><QuickAction row={r} onDone={onUpdate} /></td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
