import type { StageKey } from '../domain/workflow.ts';
import { parseSheetDate } from '../utils/dates.ts';

export interface ColumnInfo {
  index: number;          // 0-based
  letter: string;         // spreadsheet column letter
  group: string;          // stage group heading carried across the block
  header: string;
  samples: string[];
  fill_rate: number;      // 0..1 share of data rows with a value
}

export interface StageMeta {
  group: string;
  stage_key: StageKey | null;
  who: string | null;
  how: string | null;
  when: string | null;
  order: string | null;
}

export interface Layout {
  header_row: number;           // 0-based index into rows
  group_row: number | null;
  data_start: number;
  data_rows: number;
  export_at: string | null;
  columns: ColumnInfo[];
  stages: StageMeta[];
  format: 'fms_sheet' | 'flat';
}

export const norm = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

export function columnLetter(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const STAGE_PATTERNS: [RegExp, StageKey][] = [
  [/site\s*visit/, 'site_visit'],
  [/project\s*head|discussion/, 'ph_discussion'],
  [/material/, 'material'],
  [/problem\s*rais|requester|complainant|inform/, 'communicate_requester'],
  [/permission|approval/, 'permission'],
  [/engineer\s*to\s*start|assign/, 'engineer_assigned'],
  [/work\s*start/, 'work_started'],
  [/work\s*complet|completion/, 'work_completed'],
  [/verif/, 'verification'],
  [/closed|closure/, 'closed'],
];

export function stageFromText(text: string): StageKey | null {
  const t = norm(text);
  if (!t) return null;
  for (const [re, key] of STAGE_PATTERNS) if (re.test(t)) return key;
  return null;
}

const HEADER_WORDS = ['timestamp', 'property', 'work category', 'narration', 'planned', 'actual', 'status', 'time delay', 'remarks', 'image link'];

export function detectLayout(rows: string[][]): Layout {
  // Header row: the row among the first 30 matching the most known header words.
  let headerRow = 0;
  let best = -1;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = rows[i].map(norm);
    const score = HEADER_WORDS.reduce((a, w) => a + (cells.some((c) => c === w || c.startsWith(w)) ? 1 : 0), 0);
    if (score > best) { best = score; headerRow = i; }
  }
  const header = rows[headerRow] ?? [];
  const width = Math.max(header.length, ...rows.slice(headerRow, headerRow + 50).map((r) => r.length));

  // Group row: nearest row above the header naming at least two stages.
  let groupRow: number | null = null;
  for (let i = headerRow - 1; i >= 0; i--) {
    const hits = rows[i].filter((c) => stageFromText(c)).length;
    if (hits >= 2) { groupRow = i; break; }
  }

  const groups: string[] = new Array(width).fill('');
  if (groupRow !== null) {
    let current = '';
    for (let c = 0; c < width; c++) {
      const v = (rows[groupRow][c] ?? '').trim();
      if (v) current = v;
      groups[c] = current;
    }
  }

  // Who / How / When / step-order rows between the group row and the header.
  const metaRows: Record<string, string[]> = {};
  if (groupRow !== null) {
    for (let i = groupRow + 1; i < headerRow; i++) {
      const first = norm(rows[i][0]);
      const key = ['who', 'how', 'when'].includes(first) ? first : /\d+(st|nd|rd|th)/i.test(rows[i].find((c) => c.trim()) ?? '') ? 'order' : null;
      if (key) metaRows[key] = rows[i];
    }
  }
  const stages: StageMeta[] = [];
  if (groupRow !== null) {
    for (let c = 0; c < width; c++) {
      const v = (rows[groupRow][c] ?? '').trim();
      if (!v) continue;
      const pick = (k: string) => (metaRows[k]?.[c] ?? '').trim() || null;
      stages.push({ group: v, stage_key: stageFromText(v), who: pick('who'), how: pick('how'), when: pick('when'), order: pick('order') });
    }
  }

  // Export timestamp: first parseable date in the first cell of any row above the group/header row.
  let exportAt: string | null = null;
  for (let i = 0; i < (groupRow ?? headerRow); i++) {
    const d = parseSheetDate(rows[i][0]);
    if (d) { exportAt = d; break; }
  }

  const data = rows.slice(headerRow + 1).filter((r) => r.some((c) => c.trim() !== ''));
  const columns: ColumnInfo[] = [];
  for (let c = 0; c < width; c++) {
    const values = data.map((r) => (r[c] ?? '').trim()).filter(Boolean);
    const samples: string[] = [];
    for (const v of values) {
      if (!samples.includes(v)) samples.push(v.length > 60 ? v.slice(0, 60) + '…' : v);
      if (samples.length >= 4) break;
    }
    columns.push({
      index: c, letter: columnLetter(c), group: groups[c], header: (header[c] ?? '').trim(), samples,
      fill_rate: data.length ? Math.round((values.length / data.length) * 1000) / 1000 : 0,
    });
  }

  return {
    header_row: headerRow,
    group_row: groupRow,
    data_start: headerRow + 1,
    data_rows: data.length,
    export_at: exportAt,
    columns,
    stages,
    format: groupRow !== null ? 'fms_sheet' : 'flat',
  };
}
