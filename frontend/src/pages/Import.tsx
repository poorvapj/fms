import { useMemo, useState, type DragEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading, PageHead, Pager, StageStatusBadge, StatusBadge } from '../components/ui';
import { api, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtBytes, fmtDateTime, fmtDuration } from '../lib/format';
import { useLoad } from '../lib/hooks';

interface Column { index: number; letter: string; group: string; header: string; samples: string[]; fill_rate: number }
interface Target { key: string; label: string; group: string; required?: boolean }
interface Preview {
  upload_id: string; file_name: string; file_size: number; delimiter: string; total_lines: number;
  layout: { header_row: number; group_row: number | null; data_start: number; data_rows: number; export_at: string | null; format: string; columns: Column[]; stages: { group: string; stage_key: string | null; who: string | null; how: string | null; when: string | null }[] };
  head_rows: string[][]; sample_rows: { row_no: number; cells: string[] }[];
  mapping: Record<string, string>; targets: Target[];
  default_options: Options;
}
interface Options { infer_planned: boolean; auto_create_masters: boolean; mode: 'skip' | 'update' }
interface IssueGroup { severity: 'error' | 'warning'; field: string; message: string; count: number; rows: number[] }
interface Summary {
  total_rows: number; error_rows: number; warning_rows: number; create: number; update: number; skip_existing: number; skip_modified: number; skip_duplicate: number;
  masters_to_create: { properties: string[]; categories: string[]; engineers: string[] }; outcome_status: Record<string, number>; issue_groups: IssueGroup[];
}
interface Validation {
  summary: Summary;
  samples: { row_no: number; requested_at: string; property: string; category: string; title: string; engineer: string | null; status: string; stages: { key: string; name: string; status: string; planned_at: string | null; actual_at: string | null; delay_minutes: number | null; planned_inferred: boolean; actual_inferred: boolean; engineer: string | null }[] }[];
}

const STEPS = ['Upload', 'Preview', 'Map columns', 'Validate', 'Import', 'Summary'];

function Steps({ at }: { at: number }) {
  return <div className="steps">{STEPS.map((s, i) => <div key={s} className={`wiz-step${i === at ? ' on' : i < at ? ' done' : ''}`}><span className="n">{i < at ? '✓' : i + 1}</span>{s}</div>)}</div>;
}

function Stat({ k, v, tone }: { k: string; v: number | string; tone?: 'good' | 'bad' | 'warn' }) {
  return <div className={`stat ${tone ?? ''}`}><div className="k">{k}</div><div className="v">{typeof v === 'number' ? v.toLocaleString('en-IN') : v}</div></div>;
}

function IssueTable({ groups }: { groups: IssueGroup[] }) {
  if (!groups.length) return <div className="alert ok"><Icon name="checkCircle" />No errors or warnings.</div>;
  return (
    <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
      <table className="table compact">
        <thead><tr><th>Severity</th><th>Field</th><th>Issue</th><th className="num">Rows</th><th>Sheet rows (sample)</th></tr></thead>
        <tbody>
          {groups.map((g, i) => (
            <tr key={i}>
              <td><span className={`badge ${g.severity === 'error' ? 'cancelled' : 'pending_action'}`}>{g.severity}</span></td>
              <td>{g.field}</td><td>{g.message}</td><td className="num">{g.count}</td>
              <td className="small muted">{g.rows.slice(0, 10).join(', ')}{g.count > 10 ? '…' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ImportWizard() {
  const nav = useNavigate();
  const { refreshMeta } = useAuth();
  const [step, setStep] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<Options>({ infer_planned: true, auto_create_masters: true, mode: 'skip' });
  const [validation, setValidation] = useState<Validation | null>(null);
  const [result, setResult] = useState<(Summary & { batch_id: number; created: number; updated: number }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const p = await api.post<Preview>('/imports/upload', fd);
      setPreview(p); setMapping(p.mapping); setOptions(p.default_options); setStep(1);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const validate = async () => {
    setBusy(true); setError(null);
    try {
      setValidation(await api.post<Validation>(`/imports/uploads/${preview!.upload_id}/validate`, { mapping, options }));
      setStep(3);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const commit = async () => {
    setBusy(true); setError(null); setStep(4);
    try {
      setResult(await api.post(`/imports/uploads/${preview!.upload_id}/commit`, { mapping, options }));
      await refreshMeta();
      setStep(5);
    } catch (e) { setError(errorText(e)); setStep(3); } finally { setBusy(false); }
  };

  const targetsByGroup = useMemo(() => {
    const m = new Map<string, Target[]>();
    for (const t of preview?.targets ?? []) m.set(t.group, [...(m.get(t.group) ?? []), t]);
    return [...m.entries()];
  }, [preview]);
  const used = new Map(Object.entries(mapping).filter(([, t]) => t).map(([c, t]) => [t, c]));
  const missingRequired = (preview?.targets ?? []).filter((t) => t.required && !used.has(t.key));
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files[0]); };

  return (
    <>
      <PageHead title="FMS Import" sub="Bring the legacy FMS sheet (TSV/CSV export) into Job Card Management without losing history"
        actions={<Link className="btn" to="/import/history"><Icon name="history" size={14} />Import history</Link>} />
      <Steps at={step} />
      <ErrorBox error={error} />

      {step === 0 && (
        <div className="card">
          <div className="card-body stack">
            <label className={`dropzone${drag ? ' drag' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
              {busy ? <Loading label="Reading file…" /> : <>
                <Icon name="upload" size={28} />
                <div style={{ fontWeight: 600, marginTop: 8 }}>Drop the FMS export here, or click to choose</div>
                <div className="muted small">Google Sheets → File → Download → Tab-separated values (.tsv) or CSV · up to 25 MB</div>
              </>}
              <input type="file" accept=".tsv,.csv,.txt" hidden onChange={(e) => upload(e.target.files?.[0])} />
            </label>
            <div className="muted small">Nothing is written until you confirm on the Validate step. Re-importing the same sheet later is safe: rows already imported are detected and skipped (or refreshed, if you choose).</div>
          </div>
        </div>
      )}

      {step === 1 && preview && (
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>{preview.file_name}</h2><span className="muted small">{fmtBytes(preview.file_size)} · {preview.delimiter}-separated · {preview.total_lines.toLocaleString('en-IN')} lines</span></div>
            <div className="card-body stack">
              <div className="stat-row">
                <Stat k="Layout detected" v={preview.layout.format === 'fms_sheet' ? 'FMS sheet' : 'Flat table'} />
                <Stat k="Header row" v={`Row ${preview.layout.header_row + 1}`} />
                <Stat k="Data rows" v={preview.layout.data_rows} />
                <Stat k="Columns" v={preview.layout.columns.length} />
                <Stat k="Export time" v={preview.layout.export_at ? fmtDateTime(preview.layout.export_at) : '—'} />
              </div>
              {preview.layout.stages.length > 0 && (
                <>
                  <h3>Workflow stages found in the sheet</h3>
                  <div className="table-wrap"><table className="table compact">
                    <thead><tr><th>Sheet stage</th><th>Maps to</th><th>Who</th><th>How</th><th>When (SLA)</th></tr></thead>
                    <tbody>{preview.layout.stages.map((s) => (
                      <tr key={s.group}><td style={{ fontWeight: 600 }}>{s.group}</td><td>{s.stage_key ? preview.targets.find((t) => t.key.startsWith(`stage.${s.stage_key}.`))?.group : <span className="muted">not recognised</span>}</td><td>{s.who ?? '—'}</td><td>{s.how ?? '—'}</td><td>{s.when ?? '—'}</td></tr>
                    ))}</tbody>
                  </table></div>
                </>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Raw preview</h2><span className="muted small">Header block and first data rows exactly as in the file</span></div>
            <div className="table-wrap" style={{ maxHeight: 420 }}>
              <table className="table raw-table">
                <thead><tr><th>Row</th>{preview.layout.columns.map((c) => <th key={c.index}>{c.letter}</th>)}</tr></thead>
                <tbody>
                  {preview.head_rows.map((r, i) => <tr key={`h${i}`} className={i === preview.layout.header_row ? 'hdr' : 'meta'}><td>{i + 1}</td>{r.map((c, j) => <td key={j} title={c}>{c}</td>)}</tr>)}
                  {preview.sample_rows.map((r) => <tr key={r.row_no}><td>{r.row_no}</td>{r.cells.map((c, j) => <td key={j} title={c}>{c}</td>)}</tr>)}
                </tbody>
              </table>
            </div>
            <div className="modal-foot"><button className="btn" onClick={() => { setStep(0); setPreview(null); }}>Choose another file</button><button className="btn primary" onClick={() => setStep(2)}>Next: map columns</button></div>
          </div>
        </div>
      )}

      {step === 2 && preview && (
        <div className="card">
          <div className="card-head"><h2>Column mapping</h2><span className="muted small">Proposed automatically — adjust any column. Unmapped columns are still preserved in the raw FMS record.</span></div>
          <div className="table-wrap" style={{ maxHeight: 560, overflowY: 'auto' }}>
            <table className="table compact">
              <thead><tr><th>Col</th><th>Stage group</th><th>Header</th><th>Sample values</th><th className="num">Filled</th><th style={{ minWidth: 280 }}>Maps to</th></tr></thead>
              <tbody>
                {preview.layout.columns.map((c) => {
                  const t = mapping[String(c.index)] ?? '';
                  const dupe = t && used.get(t) !== String(c.index);
                  return (
                    <tr key={c.index}>
                      <td className="mono">{c.letter}</td>
                      <td className="small muted">{c.group || '—'}</td>
                      <td style={{ fontWeight: 600 }}>{c.header || <span className="muted">(blank)</span>}</td>
                      <td className="small muted" style={{ maxWidth: 280 }}>{c.samples.join(' · ') || '—'}</td>
                      <td className="num small">{Math.round(c.fill_rate * 100)}%</td>
                      <td>
                        <select className="select" style={{ height: 32, borderColor: dupe ? 'var(--bad)' : undefined }} value={t} onChange={(e) => setMapping({ ...mapping, [String(c.index)]: e.target.value })}>
                          <option value="">— Ignore (kept in raw record) —</option>
                          {targetsByGroup.map(([g, ts]) => <optgroup key={g} label={g}>{ts.map((x) => <option key={x.key} value={x.key}>{x.label}{x.required ? ' *' : ''}</option>)}</optgroup>)}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="card-body stack" style={{ borderTop: '1px solid var(--border)' }}>
            <h3>Options</h3>
            <label className="check"><input type="checkbox" checked={options.infer_planned} onChange={(e) => setOptions({ ...options, infer_planned: e.target.checked })} />Fill blank Planned dates from SLA rules (marked “SLA” on the timeline)</label>
            <label className="check"><input type="checkbox" checked={options.auto_create_masters} onChange={(e) => setOptions({ ...options, auto_create_masters: e.target.checked })} />Create properties, categories and engineers that don't exist yet</label>
            <div className="row">
              <span className="label-text">Rows already imported:</span>
              <div className="seg">
                <button type="button" className={options.mode === 'skip' ? 'on' : ''} onClick={() => setOptions({ ...options, mode: 'skip' })}>Skip</button>
                <button type="button" className={options.mode === 'update' ? 'on' : ''} onClick={() => setOptions({ ...options, mode: 'update' })}>Refresh if untouched in app</button>
              </div>
            </div>
            {missingRequired.length > 0 && <div className="alert error">Map required fields: {missingRequired.map((t) => t.label).join(', ')}</div>}
          </div>
          <div className="modal-foot"><button className="btn" onClick={() => setStep(1)}>Back</button><button className="btn primary" disabled={busy || missingRequired.length > 0} onClick={validate}>{busy ? 'Validating…' : 'Validate'}</button></div>
        </div>
      )}

      {step === 3 && validation && (
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Validation result</h2><span className="muted small">Dry run — nothing has been saved yet</span></div>
            <div className="card-body stack">
              <div className="stat-row">
                <Stat k="Rows in file" v={validation.summary.total_rows} />
                <Stat k="Will be created" v={validation.summary.create} tone="good" />
                <Stat k="Will be refreshed" v={validation.summary.update} />
                <Stat k="Already imported" v={validation.summary.skip_existing + validation.summary.skip_modified} />
                <Stat k="Duplicates in file" v={validation.summary.skip_duplicate} />
                <Stat k="Rows with errors (skipped)" v={validation.summary.error_rows} tone={validation.summary.error_rows ? 'bad' : undefined} />
                <Stat k="Rows with warnings" v={validation.summary.warning_rows} tone={validation.summary.warning_rows ? 'warn' : undefined} />
              </div>
              {Object.keys(validation.summary.outcome_status).length > 0 && (
                <div className="row wrap"><span className="label-text">Resulting status:</span>{Object.entries(validation.summary.outcome_status).map(([s, n]) => <span key={s} className="row"><StatusBadge status={s} /> <b className="tnum">{n.toLocaleString('en-IN')}</b></span>)}</div>
              )}
              {(['properties', 'categories', 'engineers'] as const).map((k) => validation.summary.masters_to_create[k].length > 0 && (
                <div key={k} className="small"><span className="label-text">New {k} ({validation.summary.masters_to_create[k].length}):</span> {validation.summary.masters_to_create[k].join(', ')}</div>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Errors & warnings</h2><span className="muted small">Warnings are imported with the original values preserved; error rows are skipped</span></div>
            <div className="card-body"><IssueTable groups={validation.summary.issue_groups} /></div>
          </div>
          {validation.samples.length > 0 && (
            <div className="card">
              <div className="card-head"><h2>Sample of mapped records</h2></div>
              <div className="card-body stack">
                {validation.samples.slice(0, 3).map((s) => (
                  <div key={s.row_no}>
                    <div className="row wrap" style={{ marginBottom: 6 }}><b>Row {s.row_no}</b><span>{s.property} · {s.category}</span><StatusBadge status={s.status} /><span className="muted small">{s.title}</span></div>
                    <div className="table-wrap"><table className="table compact">
                      <thead><tr><th>Stage</th><th>Status</th><th>Planned</th><th>Actual</th><th>Delay</th><th>Engineer</th></tr></thead>
                      <tbody>{s.stages.map((st) => (
                        <tr key={st.key}><td>{st.name}</td><td><StageStatusBadge status={st.status} late={(st.delay_minutes ?? 0) > 0} /></td>
                          <td className="small">{fmtDateTime(st.planned_at)}{st.planned_inferred ? ' (SLA)' : ''}</td><td className="small">{fmtDateTime(st.actual_at)}{st.actual_inferred ? ' (inferred)' : ''}</td>
                          <td className="small">{st.delay_minutes !== null ? fmtDuration(st.delay_minutes) : '—'}</td><td className="small">{st.engineer ?? '—'}</td></tr>
                      ))}</tbody>
                    </table></div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="card"><div className="modal-foot">
            <button className="btn" onClick={() => setStep(2)}>Back to mapping</button>
            <button className="btn primary" disabled={busy || !(validation.summary.create + validation.summary.update)} onClick={commit}>
              Import {(validation.summary.create + validation.summary.update).toLocaleString('en-IN')} records
            </button>
          </div></div>
        </div>
      )}

      {step === 4 && <div className="card"><Loading label="Importing — writing job cards, stage history, evidence links and raw rows…" /></div>}

      {step === 5 && result && (
        <div className="card">
          <div className="card-head"><Icon name="checkCircle" /><h2>Import complete — batch #{result.batch_id}</h2></div>
          <div className="card-body stack">
            <div className="stat-row">
              <Stat k="Created" v={result.created} tone="good" />
              <Stat k="Refreshed" v={result.updated} />
              <Stat k="Skipped (already imported)" v={result.skip_existing + result.skip_modified + result.skip_duplicate} />
              <Stat k="Error rows" v={result.error_rows} tone={result.error_rows ? 'bad' : undefined} />
              <Stat k="Warning rows" v={result.warning_rows} tone={result.warning_rows ? 'warn' : undefined} />
            </div>
            <div className="row wrap">{Object.entries(result.outcome_status).map(([s, n]) => <span key={s} className="row"><StatusBadge status={s} /> <b className="tnum">{n.toLocaleString('en-IN')}</b></span>)}</div>
            <div className="row">
              <Link className="btn primary" to="/job-cards?source=fms_import&view=open">Open imported job cards</Link>
              <Link className="btn" to={`/import/${result.batch_id}`}>Batch details & issues</Link>
              <button className="btn ghost" onClick={() => { setStep(0); setPreview(null); setValidation(null); setResult(null); nav('/import'); }}>Import another file</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

interface Batch { id: number; file_name: string; export_at: string | null; mode: string; total_rows: number; created_count: number; updated_count: number; skipped_count: number; error_count: number; warning_count: number; status: string; created_at: string; created_by_name: string | null }

export function ImportHistory() {
  const { data, error, loading } = useLoad(() => api.get<Batch[]>('/imports'), []);
  return (
    <>
      <PageHead title="Import history" sub="Every FMS import batch, with its issues" actions={<Link className="btn primary" to="/import"><Icon name="upload" size={14} />New import</Link>} />
      <div className="card">
        <ErrorBox error={error} />
        {loading ? <Loading /> : !data?.length ? <Empty title="No imports yet" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Batch</th><th>File</th><th>Imported</th><th>By</th><th className="num">Rows</th><th className="num">Created</th><th className="num">Refreshed</th><th className="num">Skipped</th><th className="num">Error rows</th><th className="num">Warning rows</th><th>Status</th></tr></thead>
            <tbody>{data.map((b) => (
              <tr key={b.id}>
                <td><Link to={`/import/${b.id}`} style={{ fontWeight: 600 }}>#{b.id}</Link></td><td>{b.file_name}</td><td className="small">{fmtDateTime(b.created_at)}</td><td>{b.created_by_name}</td>
                <td className="num">{b.total_rows}</td><td className="num">{b.created_count}</td><td className="num">{b.updated_count}</td><td className="num">{b.skipped_count}</td><td className="num">{b.error_count}</td><td className="num">{b.warning_count}</td>
                <td>{b.status === 'committed' ? <span className="badge closed">Committed</span> : <span className="badge cancelled">Rolled back</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

export function ImportBatch() {
  const { id } = useParams();
  const [severity, setSeverity] = useState('');
  const [page, setPage] = useState(1);
  const [msg, setMsg] = useState<string | null>(null);
  const { data, error, loading, reload } = useLoad(() => api.get<{
    batch: Batch & { summary: Summary; options: Options; created_by_name: string };
    issues: { row_no: number; severity: string; field: string; message: string; value: string | null }[]; issue_total: number; page: number; page_size: number;
    status_counts: { status: string; n: number }[]; modified_records: number; can_rollback: boolean;
  }>(`/imports/${id}`, { severity, page }), [id, severity, page]);

  const rollback = async () => {
    if (!confirm('Remove every request created by this batch? This cannot be undone.')) return;
    try { const r = await api.post<{ removed: number }>(`/imports/${id}/rollback`); setMsg(`Rolled back — ${r.removed} requests removed.`); reload(); } catch (e) { setMsg(errorText(e)); }
  };

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const b = data.batch;
  return (
    <>
      <PageHead title={`Import batch #${b.id}`} sub={`${b.file_name} · imported ${fmtDateTime(b.created_at)} by ${b.created_by_name}${b.export_at ? ` · sheet exported ${fmtDateTime(b.export_at)}` : ''}`}
        actions={<>
          <Link className="btn" to={`/reports/historical`}>Historical FMS report</Link>
          {data.can_rollback && <button className="btn danger" onClick={rollback}><Icon name="rotate" size={14} />Roll back batch</button>}
        </>} />
      {msg && <div className="alert info" style={{ marginBottom: 16 }}>{msg}</div>}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body stack">
          <div className="stat-row">
            <Stat k="Rows" v={b.total_rows} /><Stat k="Created" v={b.created_count} tone="good" /><Stat k="Refreshed" v={b.updated_count} /><Stat k="Skipped" v={b.skipped_count} />
            <Stat k="Error rows" v={b.error_count} tone={b.error_count ? 'bad' : undefined} /><Stat k="Warning rows" v={b.warning_count} tone={b.warning_count ? 'warn' : undefined} />
            <Stat k="Worked on in app" v={data.modified_records} />
          </div>
          <div className="row wrap">{data.status_counts.map((s) => <Link key={s.status} to={`/job-cards?source=fms_import&status=${s.status}`} className="row"><StatusBadge status={s.status} /> <b className="tnum">{s.n}</b></Link>)}</div>
          {!data.can_rollback && b.status === 'committed' && <div className="muted small">Rollback is unavailable once records have been worked on in the app or when a batch refreshed existing records.</div>}
        </div>
      </div>
      {b.summary?.issue_groups && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head"><h2>Issue summary</h2></div>
          <div className="card-body"><IssueTable groups={b.summary.issue_groups} /></div>
        </div>
      )}
      <div className="card">
        <div className="card-head">
          <h2>Row-level issues</h2>
          <div className="actions">
            <select className="select" style={{ width: 150 }} value={severity} onChange={(e) => { setSeverity(e.target.value); setPage(1); }}>
              <option value="">All</option><option value="error">Errors</option><option value="warning">Warnings</option>
            </select>
          </div>
        </div>
        {!data.issues.length ? <Empty title="No issues" /> : <>
          <div className="table-wrap"><table className="table compact">
            <thead><tr><th>Sheet row</th><th>Severity</th><th>Field</th><th>Message</th><th>Value</th></tr></thead>
            <tbody>{data.issues.map((i, n) => <tr key={n}><td className="num">{i.row_no}</td><td>{i.severity}</td><td>{i.field}</td><td>{i.message}</td><td className="small mono">{i.value ?? ''}</td></tr>)}</tbody>
          </table></div>
          <Pager page={data.page} pageSize={data.page_size} total={data.issue_total} onPage={setPage} />
        </>}
      </div>
    </>
  );
}

