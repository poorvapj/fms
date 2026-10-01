import { col, nextId, withId } from '../db/mongo.ts';
import { formatMs } from '../utils/dates.ts';
import { badRequest, int, notFound, requiredStr, str } from '../utils/http.ts';

interface HolidayDoc {
  _id: number;
  date: string; // YYYY-MM-DD
  name: string;
  property_id: number | null; // null = company-wide
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
  const doc: HolidayDoc = { _id: await nextId('holidays'), date, name, property_id: propertyId };
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
 */
export function holidayChecker(propertyId: number | null | undefined): (ms: number) => boolean {
  const dates = new Set(
    cache.filter((h) => h.property_id === null || h.property_id === propertyId).map((h) => h.date),
  );
  return (ms: number) => dates.has(formatMs(ms).slice(0, 10));
}
