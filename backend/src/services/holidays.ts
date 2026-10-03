import { col, nextId, withId } from '../db/mongo.ts';
import { formatMs } from '../utils/dates.ts';
import { badRequest, bool, int, notFound, requiredStr } from '../utils/http.ts';

interface HolidayDoc {
  _id: number;
  date: string; // YYYY-MM-DD (the year is just an anchor when recurring is true — matching ignores it)
  name: string;
  property_id: number | null; // null = company-wide
  recurring: boolean; // true = falls on this month/day every year (e.g. Diwali, Independence Day)
  source?: 'manual' | 'google'; // absent/'manual' = added by hand; 'google' = pulled from the synced Google calendar
}

/** In-memory cache of holiday dates, reloaded on every write (same pattern as stageDefs). Keyed "YYYY-MM-DD:propertyId|all". */
let cache: HolidayDoc[] = [];

export async function loadHolidays() {
  cache = await col.holidays().find().toArray() as HolidayDoc[];
}

export async function listHolidays() {
  const rows = await col.holidays().find().sort({ date: 1 }).toArray();
  return rows.map(withId);
}

export async function createHoliday(body: any) {
  const date = requiredStr(body.date, 'Date', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('Date must be YYYY-MM-DD');
  const name = requiredStr(body.name, 'Name', 120);
  const propertyId = int(body.property_id);
  const recurring = bool(body.recurring) ?? false;
  const doc: HolidayDoc = { _id: await nextId('holidays'), date, name, property_id: propertyId, recurring, source: 'manual' };
  await col.holidays().insertOne(doc);
  await loadHolidays();
  return withId(doc);
}

export async function deleteHoliday(id: number) {
  const r = await col.holidays().deleteOne({ _id: id });
  if (!r.deletedCount) throw notFound('Holiday');
  await loadHolidays();
}

/**
 * Returns a predicate usable by computePlanned/dates.ts working-day helpers: true when `ms` falls
 * on a holiday that applies company-wide or to the given property. This is what makes the Holiday
 * Calendar tab actually affect SLA/working-day computation, not just a cosmetic list.
 *
 * Recurring holidays (e.g. Diwali) match on month/day every year; one-off holidays match the exact date.
 */
interface GoogleCalendarEvent {
  summary?: string;
  start?: { date?: string; dateTime?: string };
}

/**
 * Pulls upcoming holidays from a public Google Calendar (e.g. "Holidays in India") and inserts any
 * not already present as company-wide, non-recurring holidays with source: 'google'. Safe to re-run:
 * it never touches manually-added holidays and skips any date that already has a company-wide holiday.
 */
export async function syncGoogleHolidays() {
  const apiKey = process.env.GOOGLE_CALENDAR_API_KEY;
  const calendarId = process.env.GOOGLE_HOLIDAY_CALENDAR_ID;
  if (!apiKey || !calendarId) throw badRequest('GOOGLE_CALENDAR_API_KEY / GOOGLE_HOLIDAY_CALENDAR_ID are not configured');

  const now = new Date();
  const timeMin = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1)).toISOString();
  const timeMax = new Date(Date.UTC(now.getUTCFullYear() + 2, 0, 1)).toISOString();
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
    + `?key=${encodeURIComponent(apiKey)}&timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime&maxResults=250`;

  const res = await fetch(url);
  if (!res.ok) throw badRequest(`Google Calendar API error (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const body = await res.json() as { items?: GoogleCalendarEvent[] };
  const events = body.items ?? [];

  await loadHolidays();
  const existingDates = new Set(cache.filter((h) => h.property_id === null).map((h) => h.date));
  const toInsert: HolidayDoc[] = [];
  for (const ev of events) {
    const date = ev.start?.date ?? ev.start?.dateTime?.slice(0, 10);
    if (!date || !ev.summary || existingDates.has(date)) continue;
    existingDates.add(date); // de-dupe multiple events landing on the same date within this batch too
    toInsert.push({ _id: 0, date, name: ev.summary, property_id: null, recurring: false, source: 'google' });
  }

  if (toInsert.length) {
    const firstId = await nextId('holidays', toInsert.length);
    toInsert.forEach((h, i) => { h._id = firstId + i; });
    await col.holidays().insertMany(toInsert);
    await loadHolidays();
  }
  return { fetched: events.length, inserted: toInsert.length, skipped: events.length - toInsert.length };
}

export function holidayChecker(propertyId: number | null | undefined): (ms: number) => boolean {
  const relevant = cache.filter((h) => h.property_id === null || h.property_id === propertyId);
  const exactDates = new Set(relevant.filter((h) => !h.recurring).map((h) => h.date));
  const recurringMonthDays = new Set(relevant.filter((h) => h.recurring).map((h) => h.date.slice(5)));
  return (ms: number) => {
    const d = formatMs(ms).slice(0, 10);
    return exactDates.has(d) || recurringMonthDays.has(d.slice(5));
  };
}
