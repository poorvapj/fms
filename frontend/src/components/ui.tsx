import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cap, fmtDuration, SOURCE_LABEL, STAGE_STATUS_LABEL, STATUS_LABEL } from '../lib/format';
import { Icon } from './Icon';

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${status}`}><span className="dot" />{STATUS_LABEL[status] ?? status}</span>;
}

export function PriorityBadge({ priority }: { priority: string }) {
  return <span className={`badge p-${priority}`}>{cap(priority)}</span>;
}

export function SourceBadge({ source }: { source: string }) {
  if (source === 'ui') return null;
  return <span className="badge src">{SOURCE_LABEL[source] ?? source}</span>;
}

export function StageStatusBadge({ status, late }: { status: string; late?: boolean }) {
  const cls = status === 'completed' ? (late ? 'pending_action' : 'closed') : status === 'active' ? 'in_progress' : status === 'rejected' ? 'cancelled' : 'on_hold';
  return <span className={`badge ${cls}`}>{STAGE_STATUS_LABEL[status] ?? status}{status === 'completed' && late ? ' · late' : ''}</span>;
}

export function OverdueBadge({ minutes }: { minutes: number | null }) {
  if (!minutes || minutes <= 0) return null;
  return <span className="badge overdue" title="Current stage is past its planned time"><Icon name="clock" size={12} />{fmtDuration(minutes)} overdue</span>;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="loading"><span className="spinner" /> <span style={{ marginLeft: 8 }}>{label}</span></div>;
}

export function ErrorBox({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="alert error" role="alert">
      <Icon name="alert" />
      <div className="grow">{error}</div>
      {onRetry && <button className="btn sm" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Empty({ title = 'Nothing here', children }: { title?: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name="inbox" size={28} />
      <div style={{ fontWeight: 600, color: 'var(--text-2)', marginTop: 8 }}>{title}</div>
      {children && <div className="small" style={{ marginTop: 4 }}>{children}</div>}
    </div>
  );
}

export function PageHead({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2 className="grow">{title}</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, required, help, children, full, error, className }: {
  label: string; required?: boolean; help?: ReactNode; children: ReactNode; full?: boolean; error?: string; className?: string;
}) {
  return (
    <div className={`field${full ? ' full' : ''}${error ? ' invalid' : ''}${className ? ` ${className}` : ''}`}>
      <label>{label}{required && <span className="req"> *</span>}</label>
      {help && className === 'gq' && <div className="help">{help}</div>}
      {children}
      {help && className !== 'gq' && <div className="help">{help}</div>}
      {error && <div className="field-error" role="alert"><Icon name="alert" size={14} />{error}</div>}
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  return (
    <div className="pager">
      <span className="tnum">{from.toLocaleString('en-IN')}–{Math.min(total, page * pageSize).toLocaleString('en-IN')} of {total.toLocaleString('en-IN')}</span>
      <span className="grow" />
      <button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
      <span className="tnum">Page {page} / {pages}</span>
      <button className="btn sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
    </div>
  );
}

export function Kpi({ label, value, to, hint, accent, alert, tone }: { label: string; value: number | string; to?: string; hint?: string; accent?: boolean; alert?: boolean; tone?: 'good' | 'bad' | 'warn' | 'info' }) {
  const body = (
    <>
      <span className="label">{label}</span>
      <span className="value">{typeof value === 'number' ? value.toLocaleString('en-IN') : value}</span>
      {hint && <span className="hint">{hint}</span>}
    </>
  );
  const cls = `kpi${accent ? ' accent' : ''}${alert && Number(value) > 0 ? ' alert' : ''}${tone ? ` tone-${tone}` : ''}`;
  return to ? <Link to={to} className={cls}>{body}</Link> : <div className={cls}>{body}</div>;
}

export function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(value > 0 ? 3 : 0, (value / max) * 100) : 0;
  return (
    <div className="bar-cell">
      <span className="tnum" style={{ minWidth: 38, textAlign: 'right' }}>{value.toLocaleString('en-IN')}</span>
      <div className="bar-track"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: string; count?: number }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} className={value === t.key ? 'on' : ''} onClick={() => onChange(t.key)}>
          {t.label}{t.count !== undefined && <span className="n">{t.count.toLocaleString('en-IN')}</span>}
        </button>
      ))}
    </div>
  );
}
