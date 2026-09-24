import { useParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { ErrorBox, Loading } from '../components/ui';
import { API_BASE, api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import type { RequestDetail as Detail } from '../lib/types';

/** DD/MM/YYYY, matching the printed paper Job Card format (not the app's usual "24 Sep 2026" style). */
function ddmmyyyy(v: string | null | undefined): string {
  if (!v) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

const fileUrl = (id: number) => `${API_BASE}/attachments/${id}/file`;

const BLANK_ROWS = 5;
const MATERIAL_ROWS = 5;

/**
 * Printable Job Card — reproduces the original paper form exactly (same fields, layout and order)
 * so it can be printed or saved as PDF via the browser's print dialog and used on site.
 */
export function JobCardPrint() {
  const { id } = useParams();
  const { data, error, loading } = useLoad(() => api.get<Detail>(`/requests/${id}`), [id]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return null;

  const r = data.request;
  const workLabel = r.work_type === 'new_work' ? 'New Work' : r.work_type === 'maintenance' ? 'Maintenance' : '';
  const assignedTo = r.engineer_name ?? r.site_engineer_name ?? '';
  const photo = data.attachments.find((a) => a.stage_key === 'created' && a.kind === 'file' && a.mime?.startsWith('image/'));

  return (
    <div className="print-page">
      <div className="no-print print-toolbar">
        <button className="btn" onClick={() => history.back()}><Icon name="x" size={14} />Close</button>
        <span className="grow" />
        <button className="btn primary" onClick={() => window.print()}><Icon name="download" size={14} />Print / Save as PDF</button>
      </div>

      <div className="print-sheet">
        <h1 className="print-title">JOB CARD:</h1>

        <table className="print-kv">
          <tbody>
            <tr><th>JOB CARD NO.</th><td>{r.request_no}</td></tr>
            <tr>
              <th>Image</th>
              <td>{photo && <img className="print-photo" src={fileUrl(photo.id)} alt="Location" />}</td>
            </tr>
            <tr><th>Location</th><td>{r.property_name}{r.property_no ? ` — ${r.property_no}` : ''}</td></tr>
            <tr><th>Work Category</th><td>{workLabel}</td></tr>
            <tr><th>Department</th><td>{r.category_name}</td></tr>
            <tr><th>Date of Completion</th><td>{ddmmyyyy(r.target_date)}</td></tr>
            <tr><th>Narration</th><td>{r.description}</td></tr>
          </tbody>
        </table>

        <div className="print-assign">
          <span>Work Assign to: <b>{assignedTo}</b></span>
          <span className="print-section-title">Details of Work:</span>
        </div>
        <div className="print-ruled" aria-hidden="true">
          {Array.from({ length: BLANK_ROWS }).map((_, i) => <div className="print-rule" key={i} />)}
        </div>

        <div className="print-row-heads">
          <span className="print-section-title">List of Material Required</span>
          <span className="print-section-title">PO No.:</span>
        </div>
        <table className="print-table">
          <thead><tr><th style={{ width: 48 }}>Sr. No.</th><th>Items</th><th>Quantity</th></tr></thead>
          <tbody>
            {Array.from({ length: MATERIAL_ROWS }).map((_, i) => (
              <tr key={i}><td>{i + 1}</td><td>&nbsp;</td><td>&nbsp;</td></tr>
            ))}
          </tbody>
        </table>

        <div className="print-row-heads">
          <span className="print-section-title">Vendor Details:</span>
          <span className="print-section-title">Status: <span className="print-note">(Available / Not Available)</span></span>
        </div>
        <table className="print-table">
          <tbody>
            <tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>
            <tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>
          </tbody>
        </table>

        <div className="print-row-heads">
          <span className="print-section-title">Design Status: <span className="print-note">(Available / Need to Design)</span></span>
          <span className="print-section-title">Design Required <span className="print-note">(Help Ticket Raised- Yes / No)</span></span>
        </div>

        <div className="print-section-title" style={{ marginTop: 18 }}>Expected Completion Date:</div>

        <div className="print-signatures">
          <span>(Signature of Attende)</span>
          <span>(Signature of Project Head)</span>
        </div>
      </div>
    </div>
  );
}
