import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { AuthProvider, useAuth } from './lib/auth';
import { Account } from './pages/Account';
import { Dashboard } from './pages/Dashboard';
import { ImportBatch, ImportHistory, ImportWizard } from './pages/Import';
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

/** Home: dashboard for managers, My Jobs for engineers and requesters. */
function Home() {
  const { can } = useAuth();
  return can('dashboard.view') && can('request.view_all') ? <Dashboard /> : can('request.view_all') ? <Navigate to="/job-cards" replace /> : <Navigate to="/my-jobs" replace />;
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
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<Home />} />
        <Route path="job-cards" element={<JobCards />} />
        <Route path="job-cards/:id" element={<RequestDetail />} />
        <Route path="requests/:id" element={<LegacyRedirect />} />
        <Route path="coordinator" element={<Guard perm="request.manage"><ProcessCoordinator /></Guard>} />
        <Route path="users" element={<Guard perm="users.manage"><UsersPage /></Guard>} />
        <Route path="my-jobs" element={<MyJobs />} />
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
