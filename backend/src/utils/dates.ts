// All timestamps are local wall-clock strings "YYYY-MM-DDTHH:mm:ss" (no zone).
// Arithmetic treats them as UTC internally so results never depend on the host time zone.

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function formatMs(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  return Number.isNaN(ms) ? null : ms;
}

const IST_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

/**
 * Current India (IST) wall-clock time, regardless of the host/server's own time zone.
 * The app's users and data are India-only, so "local" always means Asia/Kolkata — not wherever
 * the Node process happens to be running (e.g. a UTC server would otherwise log everything ~5.5h behind).
 */
export function nowLocal(): string {
  const parts = Object.fromEntries(IST_PARTS.formatToParts(new Date()).map((p) => [p.type, p.value]));
  // "24" at midnight is a known Intl/ICU quirk for hour12:false — normalise to "00".
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}`;
}

export function todayLocal(): string {
  return nowLocal().slice(0, 10);
}

/** Normalise any accepted input (ISO local, "YYYY-MM-DD HH:mm", browser datetime-local) to canonical form. */
export function normalizeLocal(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = toMs(String(value));
  return ms === null ? null : formatMs(ms);
}

/**
 * Parse sheet dates: "dd/mm/yyyy", "dd/mm/yyyy hh:mm", "dd/mm/yyyy hh:mm:ss" (also "-" or "." separators).
 * Falls back to ISO. Returns null when unparseable.
 */
export function parseSheetDate(text: string | null | undefined): string | null {
  if (!text) return null;
  const s = text.trim();
  if (!s) return null;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(s);
  if (m) {
    let year = +m[3];
    if (year < 100) year += 2000;
    let hour = +(m[4] ?? 0);
    const ampm = m[7]?.toUpperCase();
    if (ampm === 'PM' && hour < 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    const day = +m[1];
    const month = +m[2];
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23) return null;
    const ms = Date.UTC(year, month - 1, day, hour, +(m[5] ?? 0), +(m[6] ?? 0));
    const check = new Date(ms);
    if (check.getUTCDate() !== day) return null; // e.g. 31/02
    return formatMs(ms);
  }
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? normalizeLocal(s) : null;
}

export function diffMinutes(later: string | null, earlier: string | null): number | null {
  const a = toMs(later);
  const b = toMs(earlier);
  if (a === null || b === null) return null;
  return Math.round((a - b) / 60000);
}

const DAY = 86400000;

export function isWorkingDay(ms: number, weeklyOff: number[], isHoliday?: (ms: number) => boolean): boolean {
  return !weeklyOff.includes(new Date(ms).getUTCDay()) && !(isHoliday && isHoliday(ms));
}

export function startOfDay(ms: number): number {
  return Math.floor(ms / DAY) * DAY;
}

export function atTime(dayMs: number, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return startOfDay(dayMs) + (h * 60 + (m || 0)) * 60000;
}

export function nextWorkingDay(ms: number, weeklyOff: number[], isHoliday?: (ms: number) => boolean): number {
  let d = ms + DAY;
  while (!isWorkingDay(d, weeklyOff, isHoliday)) d += DAY;
  return d;
}

export function addWorkingDays(ms: number, days: number, weeklyOff: number[], isHoliday?: (ms: number) => boolean): number {
  let d = ms;
  for (let i = 0; i < days; i++) d = nextWorkingDay(d, weeklyOff, isHoliday);
  return d;
}

/** "HHHH:MM:SS" (sheet time-delay format) → minutes. */
export function parseDurationText(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /^\s*(-)?(\d+):(\d{2})(?::(\d{2}))?\s*$/.exec(text);
  if (!m) return null;
  const mins = +m[2] * 60 + +m[3] + Math.round(+(m[4] ?? 0) / 60);
  return m[1] ? -mins : mins;
}
