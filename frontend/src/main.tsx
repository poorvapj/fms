import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { AuthProvider, useAuth } from './lib/auth';
import { Account } from './pages/Account';
import { AuditLog } from './pages/AuditLog';
import { Dashboard } from './pages/Dashboard';
import { ImportBatch, ImportHistory, ImportWizard } from './pages/Import';
import { JobCardPrint } from './pages/JobCardPrint';
import { Login } from './pages/Login';
import { Masters, UsersPage } from './pages/Masters';
import { MyJobs } from './pages/MyJobs';
import { PublicForm } from './pages/PublicForm';
import { Reports } from './pages/Reports';
import { RequestDetail } from './pages/RequestDetail';
import { JobCards } from './pages/JobCards';
import { ProcessCoordinator } from './pages/ProcessCoordinator';
import { TrackRequest } from './pages/TrackRequest';
import './styles.css';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, meta, loading } = useAuth();
  const location = useLocation();
  if (loading || (user && !meta)) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

function Guard({ perm, children }: { perm: string; children: ReactNode }) {
  const { can } = useAuth();
  return can(perm) ? <>{children}</> : <div className="alert warn">You do not have access to this page.</div>;
}

/** Home: dashboard for managers, My Jobs for engineers and requesters — but only ever lands on a
 *  page the signed-in user actually has access to (page.job_cards / page.my_jobs), so a role or
 *  user whose page access was customised never gets bounced straight into a "no access" wall. */
function Home() {
  const { can } = useAuth();
  if (can('dashboard.view') && can('request.view_all')) return <Dashboard />;
  if (can('request.view_all') && can('page.job_cards')) return <Navigate to="/job-cards" replace />;
  if (can('page.my_jobs')) return <Navigate to="/my-jobs" replace />;
  if (can('page.job_cards')) return <Navigate to="/job-cards" replace />;
  return <div className="alert warn">You do not have access to this page.</div>;
}

function LegacyRedirect() {
  const { id } = useParams();
  return <Navigate to={`/job-cards/${id}`} replace />;
}

function App() {
  const { user } = useAuth();
  return (
    <Routes>
      <Route path="/submit" element={<PublicForm />} />
      <Route path="/track/:token" element={<TrackRequest />} />
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/job-cards/:id/print" element={<RequireAuth><JobCardPrint /></RequireAuth>} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<Home />} />
        <Route path="job-cards" element={<Guard perm="page.job_cards"><JobCards /></Guard>} />
        <Route path="job-cards/:id" element={<RequestDetail />} />
        <Route path="requests/:id" element={<LegacyRedirect />} />
        <Route path="coordinator" element={<Guard perm="request.manage"><ProcessCoordinator /></Guard>} />
        <Route path="users" element={<Guard perm="users.manage"><UsersPage /></Guard>} />
        <Route path="audit-log" element={<Guard perm="audit.view"><AuditLog /></Guard>} />
        <Route path="my-jobs" element={<Guard perm="page.my_jobs"><MyJobs /></Guard>} />
        <Route path="reports" element={<Guard perm="reports.view"><Reports /></Guard>} />
        <Route path="reports/:key" element={<Guard perm="reports.view"><Reports /></Guard>} />
        <Route path="masters" element={<Guard perm="masters.manage"><Masters /></Guard>} />
        <Route path="import" element={<Guard perm="import.run"><ImportWizard /></Guard>} />
        <Route path="import/history" element={<Guard perm="import.run"><ImportHistory /></Guard>} />
        <Route path="import/:id" element={<Guard perm="import.run"><ImportBatch /></Guard>} />
        <Route path="account" element={<Account />} />
        <Route path="*" element={<div className="alert warn">Page not found</div>} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
