import { DEFAULT_STAGES, type StageKey } from '../domain/workflow.ts';
import { norm, stageFromText, type ColumnInfo, type Layout } from './layout.ts';

export type StageField = 'planned' | 'actual' | 'status' | 'delay' | 'engineer';

export interface TargetField {
  key: string;                // e.g. "request.property" or "stage.site_visit.planned"
  label: string;
  group: string;
  required?: boolean;
}

const REQUEST_TARGETS: TargetField[] = [
  { key: 'request.requested_at', label: 'Request timestamp', group: 'Request', required: true },
  { key: 'request.property', label: 'Property', group: 'Request', required: true },
  { key: 'request.category', label: 'Work category', group: 'Request', required: true },
  { key: 'request.description', label: 'Narration / description', group: 'Request' },
  { key: 'request.title', label: 'Title', group: 'Request' },
  { key: 'request.target_date', label: 'Work completion (target) date', group: 'Request' },
  { key: 'request.priority', label: 'Priority', group: 'Request' },
  { key: 'request.requester_name', label: 'Requester name', group: 'Request' },
  { key: 'request.requester_email', label: 'Email', group: 'Request' },
  { key: 'request.work_type', label: 'Work (New Work / Maintenance)', group: 'Request' },
  { key: 'request.property_no', label: 'Property No.', group: 'Request' },
  { key: 'request.reason', label: 'Reason', group: 'Request' },
  { key: 'request.location_images', label: 'Image of location (URLs)', group: 'Request' },
  { key: 'request.completion_images', label: 'Completion image link (URLs)', group: 'Request' },
  { key: 'request.remarks', label: 'Remarks (verification)', group: 'Request' },
  { key: 'request.closure_note', label: 'Closure category / note', group: 'Request' },
];

const STAGE_FIELD_LABELS: Record<StageField, string> = {
  planned: 'Planned', actual: 'Actual', status: 'Status', delay: 'Time delay (raw)', engineer: 'Engineer name',
};

export const TARGETS: TargetField[] = [
  ...REQUEST_TARGETS,
  ...DEFAULT_STAGES.filter((s) => s.key !== 'created').flatMap((s) =>
    (Object.keys(STAGE_FIELD_LABELS) as StageField[]).map((f) => ({ key: `stage.${s.key}.${f}`, label: `${s.name} – ${STAGE_FIELD_LABELS[f]}`, group: s.name })),
  ),
];

export const TARGET_KEYS = new Set(TARGETS.map((t) => t.key));

export type Mapping = Record<string, string>; // column index (string) -> target key | "" (ignore)

function stageFieldFromHeader(h: string): StageField | null {
  if (/^planned|planned$/.test(h)) return 'planned';
  if (/^actual|actual$/.test(h)) return 'actual';
  if (/time\s*delay|^delay|delay$/.test(h)) return 'delay';
  if (/status/.test(h)) return 'status';
  if (/engg|engineer/.test(h)) return 'engineer';
  return null;
}

function requestFieldFromHeader(h: string): string | null {
  if (h === 'timestamp' || /^(request(ed)?\s*(date|at|time)|date raised|created)/.test(h)) return 'request.requested_at';
  if (/category\s*by|closure/.test(h)) return 'request.closure_note';
  if (/property\s*(no|number)|unit\s*no|flat\s*no/.test(h)) return 'request.property_no';
  if (/^property|^site$|^location$/.test(h)) return 'request.property';
  if (/e-?mail/.test(h)) return 'request.requester_email';
  if (/^work$|^work\s*type|^type\s*of\s*work/.test(h)) return 'request.work_type';
  if (/^reason/.test(h)) return 'request.reason';
  if (/work\s*category|^category/.test(h)) return 'request.category';
  if (/work\s*completion\s*date|target\s*date|due\s*date/.test(h)) return 'request.target_date';
  if (/image\s*of\s*location|location\s*image/.test(h)) return 'request.location_images';
  if (/image\s*link|completion\s*image|evidence/.test(h)) return 'request.completion_images';
  if (/narration|description|problem|complaint/.test(h)) return 'request.description';
  if (/^remarks?/.test(h)) return 'request.remarks';
  if (/^title|subject/.test(h)) return 'request.title';
  if (/priority/.test(h)) return 'request.priority';
  if (/requester|raised\s*by|requested\s*by/.test(h)) return 'request.requester_name';
  return null;
}

const looksLikeNames = (c: ColumnInfo) => c.samples.length > 0 && c.samples.every((s) => /^[A-Za-z][A-Za-z .'-]{1,40}$/.test(s));

/** Propose a target for every column from the detected layout. */
export function proposeMapping(layout: Layout): Mapping {
  const mapping: Mapping = {};
  const used = new Set<string>();
  const assign = (col: ColumnInfo, key: string | null) => {
    if (key && !used.has(key)) { mapping[String(col.index)] = key; used.add(key); }
    else mapping[String(col.index)] = '';
  };
  for (const col of layout.columns) {
    const h = norm(col.header);
    const reqField = h ? requestFieldFromHeader(h) : null;
    const stageKey = stageFromText(col.group) ?? stageFromText(h);
    const field = h ? stageFieldFromHeader(h) : null;
    // Stage fields inside a stage block ("Planned" under "Site Visit"), or flat headers like "Site Visit Planned".
    if (stageKey && field && !(reqField && !col.group)) {
      assign(col, `stage.${stageKey}.${field}`);
      continue;
    }
    if (reqField) {
      assign(col, reqField);
      continue;
    }
    // Unnamed column inside a stage block holding names → that stage's engineer (FMS column AK).
    if (!h && stageKey && looksLikeNames(col) && !used.has(`stage.${stageKey}.engineer`)) {
      assign(col, `stage.${stageKey}.engineer`);
      continue;
    }
    mapping[String(col.index)] = '';
  }
  return mapping;
}

export function validateMapping(mapping: Mapping, width: number): string[] {
  const errors: string[] = [];
  const seen = new Map<string, string>();
  for (const [col, target] of Object.entries(mapping)) {
    if (!target) continue;
    const idx = Number(col);
    if (!Number.isInteger(idx) || idx < 0 || idx >= width) errors.push(`Invalid column ${col}`);
    if (!TARGET_KEYS.has(target)) errors.push(`Unknown target field ${target}`);
    if (seen.has(target)) errors.push(`"${TARGETS.find((t) => t.key === target)?.label}" is mapped to more than one column`);
    seen.set(target, col);
  }
  for (const t of TARGETS.filter((x) => x.required)) {
    if (!seen.has(t.key)) errors.push(`Required field "${t.label}" is not mapped`);
  }
  return errors;
}
