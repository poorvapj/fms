import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { EMPTY_JOB_CARD, JobCardForm, missingKeys, toFormData, type FieldKey, type JobCardValues } from '../components/JobCardForm';
import { ErrorBox, Loading } from '../components/ui';
import { api, errorText } from '../lib/api';

interface Options { properties: { id: number; name: string }[]; categories: { id: number; name: string }[]; work_types: { key: string; label: string }[] }

/** "Job Card-Work Capture Form" — open form (no login), replaces the Google Form. */
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
    if (missingKeys(value, images, { email: true }).length) {
      // Wait for the highlighted questions to render, then bring the first one into view.
      setTimeout(() => document.querySelector('.field.invalid')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
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
    <div className="public-wrap">
      <div className="public-card">
        <div className="card" style={{ borderTop: '8px solid var(--accent)', marginBottom: 12 }}>
          <div className="card-body">
            <h1 style={{ fontSize: 24 }}>Job Card-Work Capture Form</h1>
            <div className="small muted" style={{ marginTop: 6 }}>Raise a new work or maintenance job. <span style={{ color: 'var(--bad)' }}>* Indicates required question</span></div>
          </div>
        </div>
        {done ? (
          <div className="card">
            <div className="card-body stack">
              <div className="alert ok"><Icon name="checkCircle" /><div><b>Job card submitted.</b> Your job card number is <b>{done.request_no}</b>.</div></div>
              <p style={{ margin: 0 }}>The Process Coordinator will review and approve it. Save this link to check progress:</p>
              <div className="row">
                <input className="input mono" readOnly value={trackUrl} onFocus={(e) => e.target.select()} />
                <button className="btn" onClick={() => navigator.clipboard?.writeText(trackUrl)}>Copy</button>
              </div>
              <div className="row">
                <Link className="btn primary" to={`/track/${done.tracking_token}`}>Track this job card</Link>
                <button className="btn" onClick={() => { setDone(null); clear(); setValue({ ...EMPTY_JOB_CARD, requester_email: value.requester_email }); }}>Submit another response</button>
              </div>
            </div>
          </div>
        ) : (
          <form className="card" onSubmit={submit} noValidate>
            <div className="card-body stack">
              <ErrorBox error={loadError} />
              {!opts && !loadError ? <Loading /> : opts && (
                <JobCardForm publicMode value={value} onChange={setValue} images={images} onImages={setImages} onError={setError} options={opts} invalid={invalid} />
              )}
              {/* honeypot — hidden from people */}
              <input className="sr-only" tabIndex={-1} autoComplete="off" aria-hidden="true" value={website} onChange={(e) => setWebsite(e.target.value)} name="website" />
              {tried && invalid.length > 0 && <div className="alert error"><Icon name="alert" />Please answer the questions marked in red.</div>}
              <ErrorBox error={error} />
            </div>
            <div className="modal-foot" style={{ justifyContent: 'space-between' }}>
              <button type="button" className="btn ghost" onClick={clear}>Clear form</button>
              <button className="btn primary" disabled={busy || !opts}>{busy ? 'Submitting…' : 'Submit'}</button>
            </div>
          </form>
        )}
        <p className="muted small" style={{ textAlign: 'center', marginTop: 16 }}>Staff? <Link to="/login">Sign in</Link></p>
      </div>
    </div>
  );
}
