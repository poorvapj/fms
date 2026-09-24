import type { ReactNode } from 'react';
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

export type FieldKey = keyof JobCardValues | 'images';

/** Required questions that are still empty, in form order. */
export function missingKeys(v: JobCardValues, images: File[], { email }: { email: boolean }): FieldKey[] {
  const miss: FieldKey[] = [];
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.requester_email.trim())) miss.push('requester_email');
  if (!v.work_type) miss.push('work_type');
  if (!v.category_id) miss.push('category_id');
  if (!v.property_id) miss.push('property_id');
  if (!v.property_no.trim()) miss.push('property_no');
  if (!v.target_date) miss.push('target_date');
  if (!images.length) miss.push('images');
  if (!v.description.trim()) miss.push('description');
  if (email && !v.reason.trim()) miss.push('reason');
  return miss;
}

export const FIELD_LABELS: Record<FieldKey, string> = {
  requester_email: 'Email', requester_name: 'Requester name', requester_contact: 'Contact', work_type: 'Work', category_id: 'Work Category',
  property_id: 'Property', property_no: 'Property No.', target_date: 'Work Completion Date', images: 'Image of Location',
  description: 'Narration', reason: 'Reason',
};

export function missingFields(v: JobCardValues, images: File[], opts: { email: boolean }): string[] {
  return missingKeys(v, images, opts).map((k) => FIELD_LABELS[k]);
}

/** Job card questions in a two-column grid. `invalid` marks questions to highlight with "This is a required question". */
export function JobCardForm({ value, onChange, images, onImages, options, publicMode, onError, invalid = [] }: {
  value: JobCardValues; onChange: (v: JobCardValues) => void; images: File[]; onImages: (f: File[]) => void;
  options: Options; publicMode?: boolean; onError: (msg: string) => void; invalid?: FieldKey[];
}) {
  const set = (k: keyof JobCardValues) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  const q = (key: FieldKey, label: string, required: boolean, control: ReactNode, opts: { help?: ReactNode; full?: boolean } = {}) => {
    const bad = invalid.includes(key);
    const error = bad ? (key === 'requester_email' && value.requester_email.trim() ? 'Enter a valid email address' : 'This is a required question') : undefined;
    return (
      <Field key={key} label={label} required={required} full={opts.full} help={opts.help} error={error}>
        {control}
      </Field>
    );
  };
  const sel = (k: 'work_type' | 'category_id' | 'property_id', items: { value: string | number; label: string }[]) => (
    <select className="select" value={value[k]} onChange={set(k)}>
      <option value="">Choose</option>
      {items.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );

  const questions = [
    publicMode
      ? q('requester_email', 'Email', true, <input className="input" type="email" autoComplete="email" value={value.requester_email} onChange={set('requester_email')} placeholder="Your email" maxLength={200} />, { full: true })
      : null,
    !publicMode ? q('requester_name', 'Requester name', false, <input className="input" value={value.requester_name} onChange={set('requester_name')} maxLength={120} />) : null,
    !publicMode ? q('requester_email', 'Requester email', false, <input className="input" type="email" value={value.requester_email} onChange={set('requester_email')} maxLength={200} placeholder="name@company.com" />) : null,
    q('work_type', 'Work', true, sel('work_type', options.work_types.map((w) => ({ value: w.key, label: w.label })))),
    q('category_id', 'Work Category', true, sel('category_id', options.categories.map((c) => ({ value: c.id, label: c.name })))),
    q('property_id', 'Property', true, sel('property_id', options.properties.map((p) => ({ value: p.id, label: p.name })))),
    q('property_no', 'Property No.', true, <input className="input" value={value.property_no} onChange={set('property_no')} placeholder="e.g. B-204 / Villa 12 / Block C" maxLength={120} />),
    q('target_date', 'Work Completion Date', true, <input type="date" className="input" min={todayInput()} value={value.target_date} onChange={set('target_date')} />),
    <div key="date-spacer" />, // date sits alone on its row
    q('images', 'Image of Location', true, <ImagePicker files={images} onChange={onImages} max={10} onError={onError} label="Add photo" />,
      { full: true, help: 'Upload up to 10 photos (max 15 MB each).' }),
    q('description', 'Narration', true, <textarea className="input" value={value.description} onChange={set('description')} maxLength={5000} placeholder="Describe the work / problem" />, { full: true }),
    q('reason', 'Reason', !!publicMode, <input className="input" value={value.reason} onChange={set('reason')} maxLength={2000} placeholder="Why is this work needed?" />, { full: true }),
  ];

  return <div className="form-grid">{questions}</div>;
}

export function toFormData(v: JobCardValues, images: File[], extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  for (const [k, val] of Object.entries({ ...v, ...extra })) if (val) fd.append(k, val);
  images.forEach((f) => fd.append('images', f));
  return fd;
}
