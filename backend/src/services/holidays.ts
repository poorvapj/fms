import { col, nextId, withId } from '../db/mongo.ts';
import { formatMs } from '../utils/dates.ts';
import { badRequest, bool, int, notFound, requiredStr } from '../utils/http.ts';

interface HolidayDoc {
  _id: number;
  date: string; // YYYY-MM-DD (the year is just an anchor when recurring is true — matching ignores it)
  name: string;
  property_id: number | null; // null = company-wide
  recurring: boolean; // true = falls on this month/day every year (e.g. Diwali, Independence Day)
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
  const doc: HolidayDoc = { _id: await nextId('holidays'), date, name, property_id: propertyId, recurring };
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
export function holidayChecker(propertyId: number | null | undefined): (ms: number) => boolean {
  const relevant = cache.filter((h) => h.property_id === null || h.property_id === propertyId);
  const exactDates = new Set(relevant.filter((h) => !h.recurring).map((h) => h.date));
  const recurringMonthDays = new Set(relevant.filter((h) => h.recurring).map((h) => h.date.slice(5)));
  return (ms: number) => {
    const d = formatMs(ms).slice(0, 10);
    return exactDates.has(d) || recurringMonthDays.has(d.slice(5));
  };
}
