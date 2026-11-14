// Automatic intake for new "Pending Complaint" Google Form submissions — pushed here by an
// Apps Script trigger on the form's linked Sheet. Reuses the legacy CSV import pipeline so a
// new submission is created exactly the way a manual single-row FMS import is, instead of
// going through the strict public-form validation path (which requires fields this form
// doesn't collect, like a reason/email/target date).
import type { AuthUser } from '../auth/auth.ts';
import { col } from '../db/mongo.ts';
import { commitImport, saveUpload, validateImport } from '../import/importService.ts';
import { notifyFormIntake } from './slack.ts';
import { HttpError } from '../utils/http.ts';

const SYSTEM_USER: AuthUser = { id: 1, username: 'admin', name: 'Administrator', role: 'admin', engineer_id: null, must_change_password: false };

const LEGEND = [
  '01/10/2026 10:45:05,0.3333333333,10,18,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,',
  '  ,,,,,,Site Visit,,,,,Discussion with Project Head,,,,,Material Update,,,,Communicate to Problem Raised,,,,Get Permission from Rahul Sir,,,,Communicate to Engineer to Start PC ,,,,Work Completion ,,,,,,,',
  'Who,"Akhilesh,Sagar,Kuldeep,Mukesh,Shailendra",,,,,Site Engineer(Project Head),,,,,Site Engineer,,,,,Deepak Sir,,,,PC Mam,,,,PC Mam,,,,PC Mam,,,,PC Mam,,,,,,,',
  'How,Google Form,,,,,Physically & Fill Job Card-2 with all Details,,,,,Full Kitting & Date of Completion & Fill Google Form,,,,,Google form,,,,Whatsapp/Call,,,,Whatsapp/Call/Physically/Mail,,,,Whatsapp/Call/Physically/Mail,,,,Whatsapp/Call/Physically,,,,,,,',
  'When,Anytime,,,,,Next Day 3 PM,,,,,Same day 6 PM,,,,,1,,,,Next  day  by 10:00 AM,,,,Same  day  by 11:00 AM,,,,Same  day  by 12:00 PM,,,,7,,,,,,,',
  ',1st,,,,,2nd,,,,,3rd,,,,,3rd(1),,,,4th,,,,5th,,,,6th,,,,7th,,,,,,,',
  'Timestamp,Property,Work Category,Work Completion Date,Image of Location,Narration,Planned,Actual,Status,Time Delay,Engg Name,Planned,Actual,Status,Time Delay,Engg Name,Planned,Actual,Status,Time Delay,Planned,Actual,Status,Time Delay,Planned,Actual,Status,Time Delay,Planned,Actual,Status,Time Delay,Planned,Actual,Status,Time Delay,,Image Link,Remarks (Regarding Job Card),Category By PC Mam,Property No,Work,Email Address,Reason',
];
const ROW_WIDTH = 44;

function csvField(v: unknown): string {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface FormSubmission {
  timestamp?: string;
  property: string;
  work_category: string;
  completion_date?: string;
  image_url?: string;
  narration: string;
  property_no?: string;
  work_type?: string;
  requester_email?: string;
  reason?: string;
}

function fmtNow(): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}:${get('second')}`;
}

// Throttle: this endpoint has no secret (Apps Script can't keep one private either), so it's
// rate-limited by IP the same way the public complaint form is — 20 per IP per day.
const hits = new Map<string, number[]>();
function throttle(ip: string) {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < 86400000);
  if (list.length >= 20) throw new HttpError(429, 'Too many submissions from this source today');
  list.push(now);
  hits.set(ip, list);
}

/** Builds a single-row legacy-format CSV and runs it through the standard import pipeline. */
export async function intakeFormSubmission(body: FormSubmission, ip: string) {
  throttle(ip);
  const property = String(body.property ?? '').trim();
  const workCategory = String(body.work_category ?? '').trim();
  const narration = String(body.narration ?? '').trim();
  if (!property) throw new HttpError(400, 'Property is required');
  if (!workCategory) throw new HttpError(400, 'Work Category is required');
  if (!narration) throw new HttpError(400, 'Narration is required');

  const fields = new Array(ROW_WIDTH).fill('');
  fields[0] = String(body.timestamp ?? '').trim() || fmtNow();
  fields[1] = property;
  fields[2] = workCategory;
  fields[3] = String(body.completion_date ?? '').trim();
  fields[4] = String(body.image_url ?? '').trim();
  fields[5] = narration;
  fields[38] = 'Pending';
  fields[40] = String(body.property_no ?? '').trim();
  fields[41] = String(body.work_type ?? '').trim();
  fields[42] = String(body.requester_email ?? '').trim();
  fields[43] = String(body.reason ?? '').trim();

  const csv = [...LEGEND, fields.map(csvField).join(',')].join('\n') + '\n';
  const file = { buffer: Buffer.from(csv, 'utf8'), originalname: 'form-submission.csv', size: Buffer.byteLength(csv) };

  const uploaded = await saveUpload(file, SYSTEM_USER);
  const reqBody = { mapping: uploaded.mapping, options: uploaded.default_options };
  const validated = await validateImport(uploaded.upload_id, reqBody, SYSTEM_USER);
  if (validated.summary.error_rows > 0) {
    throw new HttpError(400, 'Submission could not be imported — check Property / Work Category spelling', validated.issues);
  }
  const result = await commitImport(uploaded.upload_id, reqBody, SYSTEM_USER);
  const created = await col.requests().findOne({ import_batch_id: result.batch_id });
  if (created) await notifyFormIntake(created, { image_url: fields[4] }).catch((e) => console.error('Form-intake Slack notify failed:', e));
  return result;
}
