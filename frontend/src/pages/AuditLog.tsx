import { ErrorBox, Loading, PageHead } from '../components/ui';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useLoad } from '../lib/hooks';

interface AuditRow { id: number; type: string; message: string; user_id: number | null; user_name: string; created_at: string }

const TYPE_LABEL: Record<string, string> = {
  login: 'Login',
  login_failed: 'Login failed',
  user_created: 'User created',
  user_updated: 'User updated',
  password_changed: 'Password changed',
};

export function AuditLog() {
  const { data, error, loading } = useLoad(() => api.get<AuditRow[]>('/audit-log'), []);
  return (
    <>
      <PageHead title="Audit Log" sub="Logins and user-management actions, most recent first" />
      <div className="card">
        <ErrorBox error={error} />
        {loading && !data ? <Loading /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>When</th><th>Type</th><th>By</th><th>Details</th></tr></thead>
              <tbody>
                {data?.map((a) => (
                  <tr key={a.id}>
                    <td className="small">{fmtDateTime(a.created_at)}</td>
                    <td><span className={`badge ${a.type === 'login_failed' ? 'on_hold' : 'closed'}`}>{TYPE_LABEL[a.type] ?? a.type}</span></td>
                    <td>{a.user_name}</td>
                    <td className="small">{a.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data && data.length === 0 && <div className="muted small" style={{ padding: 16 }}>No audit entries yet.</div>}
          </div>
        )}
      </div>
    </>
  );
}
