import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { EMPTY_JOB_CARD, JobCardForm, missingKeys, toFormData, type FieldKey, type JobCardValues } from '../components/JobCardForm';
import { ErrorBox, Loading } from '../components/ui';
import { api, errorText } from '../lib/api';

interface Options { properties: { id: number; name: string }[]; categories: { id: number; name: string }[]; work_types: { key: string; label: string }[] }

/** "Job Card-Work Capture Form" — open form (no login), laid out like the original Google Form. */
export function PublicForm() {
  const [opts, setOpts] = useState<Options | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [value, setValue] = useState<JobCardValues>(EMPTY_JOB_CARD);
  const [website, setWebsite] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ request_no: string; tracking_token: string } | null>(null);

  useEffect(() => {
    api.get<Options>('/public/form-options').then(setOpts).catch((e) => setLoadError(errorText(e)));
  }, []);

  const invalid: FieldKey[] = tried ? missingKeys(value, images, { email: true }) : [];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    setError(null);
    const missing = missingKeys(value, images, { email: true });
    if (missing.length) {
      // Wait for the red "required" cards to render, then bring the first one into view.
      setTimeout(() => document.querySelector('.gq.invalid')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
      return;
    }
    setBusy(true);
    try {
      setDone(await api.post('/public/requests', toFormData(value, images, { website })));
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const clear = () => { setValue(EMPTY_JOB_CARD); setImages([]); setTried(false); setError(null); };
  const trackUrl = done ? `${window.location.origin}/track/${done.tracking_token}` : '';

  return (
    <div className="public-wrap" style={{ background: '#fff3e8' }}>
      <div className="public-card">
        <div className="card" style={{ borderTop: '10px solid var(--accent)', marginBottom: 12 }}>
          <div className="card-body">
            <h1 style={{ fontSize: 28, fontWeight: 500 }}>Job Card-Work Capture Form</h1>
            {!done && <div className="small" style={{ marginTop: 10, color: 'var(--bad)' }}>* Indicates required question</div>}
          </div>
        </div>
        {done ? (
          <div className="card">
            <div className="card-body stack">
              <div className="alert ok"><Icon name="checkCircle" /><div><b>Your response has been recorded.</b> Job card number: <b>{done.request_no}</b></div></div>
              <p style={{ margin: 0 }}>The Process Coordinator will review and approve it. Save this link to check progress:</p>
              <div className="row">
                <input className="input mono" readOnly value={trackUrl} onFocus={(e) => e.target.select()} />
                <button className="btn" onClick={() => navigator.clipboard?.writeText(trackUrl)}>Copy</button>
              </div>
              <div className="row">
                <Link className="btn primary" to={`/track/${done.tracking_token}`}>Track this job card</Link>
                <button className="btn ghost" onClick={() => { setDone(null); clear(); setValue({ ...EMPTY_JOB_CARD, requester_email: value.requester_email }); }}>Submit another response</button>
              </div>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} noValidate>
            <ErrorBox error={loadError} />
            {!opts && !loadError ? <div className="card"><Loading /></div> : opts && (
              <JobCardForm publicMode value={value} onChange={setValue} images={images} onImages={setImages} onError={setError} options={opts} invalid={invalid} />
            )}
            {/* honeypot — hidden from people */}
            <input className="sr-only" tabIndex={-1} autoComplete="off" aria-hidden="true" value={website} onChange={(e) => setWebsite(e.target.value)} name="website" />
            {error && <div style={{ marginTop: 12 }}><ErrorBox error={error} /></div>}
            <div className="public-actions">
              <button className="btn primary" disabled={busy || !opts}>{busy ? 'Submitting…' : 'Submit'}</button>
              <button type="button" className="btn ghost" style={{ color: 'var(--accent-ink)' }} onClick={clear}>Clear form</button>
            </div>
          </form>
        )}
        <p className="muted small" style={{ textAlign: 'center', marginTop: 20 }}>Staff? <Link to="/login">Sign in</Link></p>
      </div>
    </div>
  );
}
