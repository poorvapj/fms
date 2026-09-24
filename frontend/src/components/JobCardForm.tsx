import { todayInput } from '../lib/format';
import { ImagePicker } from './ImagePicker';
import { Field } from './ui';

/** The fields of the "Job Card-Work Capture Form" — shared by the public form and the internal New Job Card popup. */
export interface JobCardValues {
  requester_email: string;
  requester_name: string;
  requester_contact: string;
  work_type: string;
  category_id: string;
  property_id: string;
  property_no: string;
  target_date: string;
  description: string;
  reason: string;
}

export const EMPTY_JOB_CARD: JobCardValues = {
  requester_email: '', requester_name: '', requester_contact: '', work_type: '', category_id: '', property_id: '',
  property_no: '', target_date: '', description: '', reason: '',
};

interface Options {
  properties: { id: number; name: string }[];
  categories: { id: number; name: string }[];
  work_types: readonly { key: string; label: string }[];
}

export function missingFields(v: JobCardValues, images: File[], { email }: { email: boolean }): string[] {
  const miss: string[] = [];
  if (email && !v.requester_email.trim()) miss.push('Email');
  if (!v.work_type) miss.push('Work');
  if (!v.category_id) miss.push('Work Category');
  if (!v.property_id) miss.push('Property');
  if (!v.property_no.trim()) miss.push('Property No.');
  if (!v.target_date) miss.push('Work Completion Date');
  if (!images.length) miss.push('Image of Location');
  if (!v.description.trim()) miss.push('Narration');
  if (email && !v.reason.trim()) miss.push('Reason');
  return miss;
}

export function JobCardForm({ value, onChange, images, onImages, options, publicMode, onError }: {
  value: JobCardValues; onChange: (v: JobCardValues) => void; images: File[]; onImages: (f: File[]) => void;
  options: Options; publicMode?: boolean; onError: (msg: string) => void;
}) {
  const set = (k: keyof JobCardValues) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="form-grid">
      {publicMode ? (
        <Field label="Email" required full>
          <input className="input" type="email" autoComplete="email" value={value.requester_email} onChange={set('requester_email')} placeholder="Your email" maxLength={200} />
        </Field>
      ) : (
        <>
          <Field label="Requester name"><input className="input" value={value.requester_name} onChange={set('requester_name')} maxLength={120} /></Field>
          <Field label="Requester email"><input className="input" type="email" value={value.requester_email} onChange={set('requester_email')} maxLength={200} placeholder="name@company.com" /></Field>
        </>
      )}
      <Field label="Work" required>
        <select className="select" value={value.work_type} onChange={set('work_type')}>
          <option value="">Choose</option>
          {options.work_types.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
        </select>
      </Field>
      <Field label="Work Category" required>
        <select className="select" value={value.category_id} onChange={set('category_id')}>
          <option value="">Choose</option>
          {options.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Property" required>
        <select className="select" value={value.property_id} onChange={set('property_id')}>
          <option value="">Choose</option>
          {options.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      <Field label="Property No." required>
        <input className="input" value={value.property_no} onChange={set('property_no')} placeholder="e.g. B-204 / Villa 12 / Block C" maxLength={120} />
      </Field>
      <Field label="Work Completion Date" required>
        <input type="date" className="input" min={todayInput()} value={value.target_date} onChange={set('target_date')} />
      </Field>
      <div />
      <Field label="Image of Location" required full help="Upload up to 10 photos (max 15 MB each).">
        <ImagePicker files={images} onChange={onImages} max={10} onError={onError} />
      </Field>
      <Field label="Narration" required full>
        <textarea className="input" value={value.description} onChange={set('description')} maxLength={5000} placeholder="Describe the work / problem" />
      </Field>
      <Field label="Reason" required={publicMode} full>
        <input className="input" value={value.reason} onChange={set('reason')} maxLength={2000} placeholder="Why is this work needed?" />
      </Field>
    </div>
  );
}

export function toFormData(v: JobCardValues, images: File[], extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  for (const [k, val] of Object.entries({ ...v, ...extra })) if (val) fd.append(k, val);
  images.forEach((f) => fd.append('images', f));
  return fd;
}
