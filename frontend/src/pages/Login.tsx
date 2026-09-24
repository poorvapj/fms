import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { ErrorBox, Field } from '../components/ui';
import { api, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';

export function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [env, setEnv] = useState<string | null>(null);
  useEffect(() => { api.get<{ env: string }>('/public/env').then((r) => setEnv(r.env)).catch(() => undefined); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      nav(loc.state?.from ?? '/', { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="public-wrap">
      <form className="card login-card" onSubmit={submit}>
        <div className="card-body stack">
          <div className="public-brand" style={{ margin: 0 }}><span className="brand-mark"><Icon name="wrench" size={16} /></span>FMS Operations</div>
          {env === 'local' && <span className="env-badge login-env">LOCAL – test data</span>}
          <div className="muted">Sign in to manage job cards.</div>
          <Field label="Username"><input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" /></Field>
          <Field label="Password"><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
          <ErrorBox error={error} />
          <button className="btn primary" disabled={busy || !username || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <div className="muted small" style={{ textAlign: 'center' }}>Need something fixed? <Link to="/submit">Raise a job card without signing in</Link></div>
        </div>
      </form>
    </div>
  );
}
