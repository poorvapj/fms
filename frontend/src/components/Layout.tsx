import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Icon } from './Icon';

interface NavItem { to: string; label: string; icon: string; perm?: string; end?: boolean }

const SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Operations',
    items: [
      { to: '/', label: 'Dashboard', icon: 'dashboard', perm: 'dashboard.view', end: true },
      { to: '/job-cards', label: 'Job Cards', icon: 'file' },
      { to: '/my-jobs', label: 'My Jobs', icon: 'list' },
      { to: '/coordinator', label: 'Process Coordinator', icon: 'alert', perm: 'request.manage' },
    ],
  },
  { title: 'Insights', items: [{ to: '/reports', label: 'Reports', icon: 'chart', perm: 'reports.view' }] },
  {
    title: 'Admin',
    items: [
      { to: '/masters', label: 'Masters', icon: 'building', perm: 'masters.manage' },
      { to: '/users', label: 'Users', icon: 'users', perm: 'users.manage' },
    ],
  },
];

export function Layout() {
  const { user, meta, can, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const nav = useNavigate();
  useEffect(() => setOpen(false), [location.pathname]);
  const roleLabel = meta?.roles.find((r) => r.key === user?.role)?.label ?? user?.role;

  return (
    <div className={`shell${open ? ' nav-open' : ''}`} onClick={(e) => { if (open && e.target === e.currentTarget) setOpen(false); }}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><Icon name="wrench" size={16} /></span>
          <div>FMS Operations<small>Job card management</small></div>
        </div>
        <nav className="nav">
          {SECTIONS.map((s) => {
            const items = s.items.filter((i) => !i.perm || can(i.perm));
            if (!items.length) return null;
            return (
              <div key={s.title}>
                <div className="nav-section">{s.title}</div>
                {items.map((i) => <NavLink key={i.to} to={i.to} end={i.end}><Icon name={i.icon} />{i.label}</NavLink>)}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <div style={{ fontWeight: 600 }}>{user?.name}</div>
          <div className="muted">{roleLabel}</div>
          <div className="row" style={{ marginTop: 8 }}>
            <NavLink to="/account" className="btn sm">Account</NavLink>
            <button className="btn sm ghost" onClick={logout}><Icon name="logout" size={14} />Sign out</button>
          </div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="btn ghost icon menu-btn" onClick={() => setOpen(true)} aria-label="Open menu"><Icon name="menu" /></button>
          <span className="grow" />
          <a className="btn sm" href="/submit" target="_blank" rel="noreferrer"><Icon name="externalLink" size={14} />Public form</a>
          {can('request.create') && <button className="btn sm primary" onClick={() => nav('/job-cards?new=1')}><Icon name="plus" size={14} />New Job Card</button>}
        </header>
        <main className="content">
          {user?.must_change_password && location.pathname !== '/account' && (
            <div className="alert warn" style={{ marginBottom: 16 }}>
              <Icon name="alert" />
              <div className="grow">You are using a temporary password. <NavLink to="/account">Change it now</NavLink>.</div>
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
