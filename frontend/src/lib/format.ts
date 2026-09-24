const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09-23T10:31:19" → "23 Sep 2026, 10:31" (values are local wall-clock, no zone conversion). */
export function fmtDateTime(v: string | null | undefined): string {
  if (!v) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(v);
  if (!m) return v;
  const d = `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}`;
  return m[4] ? `${d}, ${m[4]}:${m[5]}` : d;
}

export function fmtDate(v: string | null | undefined): string {
  if (!v) return '—';
  return fmtDateTime(v.slice(0, 10));
}

export function fmtMonth(v: string): string {
  const [y, m] = v.split('-');
  return `${MONTHS[+m - 1]} ${y.slice(2)}`;
}

/** Minutes → "3d 4h", "5h 20m", "45m". */
export function fmtDuration(mins: number | null | undefined): string {
  if (mins === null || mins === undefined) return '—';
  const neg = mins < 0;
  let m = Math.abs(Math.round(mins));
  const d = Math.floor(m / 1440);
  m -= d * 1440;
  const h = Math.floor(m / 60);
  m -= h * 60;
  const s = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  return neg ? `-${s}` : s;
}

export function fmtNumber(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-IN') : String(v);
}

export function fmtBytes(n: number | null | undefined): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** Current local time as "YYYY-MM-DDTHH:mm" for datetime-local inputs. */
export function nowInput(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function todayInput(): string {
  return nowInput().slice(0, 10);
}

export const STATUS_LABEL: Record<string, string> = {
  open: 'Raised', in_progress: 'In Progress', pending_action: 'Pending Action', pending_approval: 'Pending Approval',
  on_hold: 'On Hold', completed: 'Completed', closed: 'Closed', cancelled: 'Cancelled', active: 'All open',
};

export const STAGE_STATUS_LABEL: Record<string, string> = {
  pending: 'Pending', active: 'In progress', completed: 'Done', skipped: 'Skipped', rejected: 'Rejected',
};

export const SOURCE_LABEL: Record<string, string> = { ui: 'App', fms_import: 'FMS import', public: 'Public form' };

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
