import { useState, type FormEvent } from 'react';
import { ErrorBox, Field, PageHead } from '../components/ui';
import { api, errorText } from '../lib/api';
import { useAuth, useMeta } from '../lib/auth';

export function Account() {
  const { user, setUser } = useAuth();
  const meta = useMeta();
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setOk(false);
    if (f.next !== f.confirm) return setError('New passwords do not match');
    try {
      await api.post('/auth/change-password', { current_password: f.current, new_password: f.next });
      setOk(true);
      setError(null);
      setF({ current: '', next: '', confirm: '' });
      if (user) setUser({ ...user, must_change_password: false });
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <>
      <PageHead title="My account" sub={`${user?.name} · ${meta.roles.find((r) => r.key === user?.role)?.label}`} />
      <form className="card" style={{ maxWidth: 440 }} onSubmit={submit}>
        <div className="card-head"><h2>Change password</h2></div>
        <div className="card-body stack">
          <Field label="Current password"><input type="password" className="input" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
          <Field label="New password" help="At least 8 characters with letters and numbers"><input type="password" className="input" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field>
          <Field label="Confirm new password"><input type="password" className="input" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} /></Field>
          <ErrorBox error={error} />
          {ok && <div className="alert ok">Password changed.</div>}
          <button className="btn primary" disabled={!f.current || !f.next}>Update password</button>
        </div>
      </form>
    </>
  );
}
