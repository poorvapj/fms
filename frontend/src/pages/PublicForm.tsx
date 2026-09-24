import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { EMPTY_JOB_CARD, JobCardForm, missingFields, toFormData, type JobCardValues } from '../components/JobCardForm';
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ request_no: string; tracking_token: string } | null>(null);

  useEffect(() => {
    api.get<Options>('/public/form-options').then(setOpts).catch((e) => setLoadError(errorText(e)));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const missing = missingFields(value, images, { email: true });
    if (missing.length) return setError(`This is a required question: ${missing.join(', ')}`);
    setBusy(true);
    setError(null);
    try {
      setDone(await api.post('/public/requests', toFormData(value, images, { website })));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

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
                <button className="btn" onClick={() => { setDone(null); setImages([]); setValue({ ...EMPTY_JOB_CARD, requester_email: value.requester_email }); }}>Submit another response</button>
              </div>
            </div>
          </div>
        ) : (
          <form className="card" onSubmit={submit} noValidate>
            <div className="card-body stack">
              <ErrorBox error={loadError} />
              {!opts && !loadError ? <Loading /> : opts && (
                <JobCardForm publicMode value={value} onChange={setValue} images={images} onImages={setImages} onError={setError} options={opts} />
              )}
              {/* honeypot — hidden from people */}
              <input className="sr-only" tabIndex={-1} autoComplete="off" aria-hidden="true" value={website} onChange={(e) => setWebsite(e.target.value)} name="website" />
              <ErrorBox error={error} />
            </div>
            <div className="modal-foot" style={{ justifyContent: 'space-between' }}>
              <button type="button" className="btn ghost" onClick={() => { setValue(EMPTY_JOB_CARD); setImages([]); setError(null); }}>Clear form</button>
              <button className="btn primary" disabled={busy || !opts}>{busy ? 'Submitting…' : 'Submit'}</button>
            </div>
          </form>
        )}
        <p className="muted small" style={{ textAlign: 'center', marginTop: 16 }}>Staff? <Link to="/login">Sign in</Link></p>
      </div>
    </div>
  );
}
