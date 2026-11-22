// The fake vendor's own catalog and slot generator. No Deno or Node APIs here, so the
// same file runs in the edge function and in Vitest.
//
// Deliberate simplification: one chair per location and a fixed hourly grid, so a slot
// is identified by its start time alone. A real scheduler books variable-length services
// and needs an overlap check (in Postgres: an exclusion constraint on a tstzrange).

export type VendorLocation = {
  timezone: string;
  /** Opening hours per weekday (0 = Sunday), in minutes from local midnight. Missing = closed. */
  hours: Partial<Record<number, [open: number, close: number]>>;
};

const WEEKDAYS: VendorLocation["hours"] = {
  1: [9 * 60, 18 * 60],
  2: [9 * 60, 18 * 60],
  3: [9 * 60, 18 * 60],
  4: [9 * 60, 18 * 60],
  5: [9 * 60, 18 * 60],
  6: [10 * 60, 16 * 60],
};

const loc = (n: number) => `urn:blvd:Location:6c1f0a52-1d3e-4b7a-9f20-00000000000${n}`;

// Boulevard's location ids. Must match the mappings_to_boulevard migration.
export const VENDOR_LOCATIONS: Record<string, VendorLocation & { name: string }> = {
  [loc(1)]: { name: "NYC Noho", timezone: "America/New_York", hours: WEEKDAYS },
  [loc(2)]: { name: "NYC Grand Central", timezone: "America/New_York", hours: WEEKDAYS },
  [loc(3)]: { name: "Atlanta Buckhead", timezone: "America/New_York", hours: WEEKDAYS },
  [loc(4)]: { name: "Washington DC", timezone: "America/New_York", hours: WEEKDAYS },
};

// Boulevard's service menu. Our adapter maps treatment slugs to these ids.
export const SERVICES = [
  { id: "urn:blvd:Service:2b7d4e90-5a1c-4f3e-8d6b-000000000001", name: "PRP Hair Restoration", priceCents: 49500 },
  { id: "urn:blvd:Service:2b7d4e90-5a1c-4f3e-8d6b-000000000002", name: "Laser Hair Restoration", priceCents: 49500 },
  { id: "urn:blvd:Service:2b7d4e90-5a1c-4f3e-8d6b-000000000003", name: "PRP + Laser Bundle", priceCents: 66000 },
] as const;

export const SLOT_MINUTES = 60;
export const BOOKING_WINDOW_DAYS = 60;
/** Share of slots shown as already taken, so a day looks realistically busy. */
const BUSY_PERCENT = 35;

export type Slot = {
  /** Boulevard returns times with an offset, e.g. 2026-11-25T09:00:00-05:00 */
  startTime: string;
  /** Opaque bookable time id, passed back to reserveCartBookableItems. */
  id: string;
  /** Precision Scheduling: higher means a better fit for the calendar. */
  score: number;
  /** The same instant as startTime, for comparisons. Not sent over the wire. */
  start: Date;
};

/** Parses YYYY-MM-DD, rejecting impossible dates like 2026-02-30. */
export function parseDate(value: string | null): { year: number; month: number; day: number } | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function zonedParts(instant: Date, timezone: string): Parts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** Minutes the zone is ahead of UTC at this instant (New York in winter: -300). */
function offsetMinutes(instant: Date, timezone: string): number {
  const p = zonedParts(instant, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/** Local wall time in a zone -> the real instant. Re-checks the offset to handle DST changes. */
export function localToUtc(date: { year: number; month: number; day: number }, minutes: number, timezone: string): Date {
  const guess = Date.UTC(date.year, date.month - 1, date.day, 0, minutes);
  const first = offsetMinutes(new Date(guess), timezone);
  const second = offsetMinutes(new Date(guess - first * 60000), timezone);
  return new Date(guess - second * 60000);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The instant as local wall time with its offset: 2026-11-25T09:00:00-05:00 */
export function formatLocal(instant: Date, timezone: string): string {
  const p = zonedParts(instant, timezone);
  const offset = offsetMinutes(instant, timezone);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The local calendar date of an instant in a zone. */
export function localDate(instant: Date, timezone: string): { year: number; month: number; day: number } {
  const { year, month, day } = zonedParts(instant, timezone);
  return { year, month, day };
}

// FNV-1a: a tiny stable hash, so the same day always shows the same "busy" slots.
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** First instant of the local day and of the next one, for range queries. */
export function dayBounds(date: { year: number; month: number; day: number }, timezone: string): [Date, Date] {
  return [localToUtc(date, 0, timezone), localToUtc(date, 24 * 60, timezone)];
}

export const formatDate = (d: { year: number; month: number; day: number }) => `${d.year}-${pad(d.month)}-${pad(d.day)}`;

/** Bookable time ids look like Boulevard's (t_2026-11-25T09:00:00, local time). Treat as opaque. */
function timeId(start: Date, timezone: string): string {
  return `t_${formatLocal(start, timezone).slice(0, 19)}`;
}

/** The instant a bookable time id refers to, or null if it isn't one of ours. */
export function parseTimeId(id: string, timezone: string): Date | null {
  const match = id.match(/^t_(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):00$/);
  const date = match && parseDate(match[1]);
  if (!match || !date) return null;
  return localToUtc(date, Number(match[2]) * 60 + Number(match[3]), timezone);
}

/**
 * Every slot the vendor would offer for one local day, before removing reserved ones.
 * Deterministic: depends only on the inputs. Closed days and past times return [].
 */
export function generateSlots(
  locationId: string,
  date: { year: number; month: number; day: number },
  now: Date,
): Slot[] {
  const location = VENDOR_LOCATIONS[locationId];
  if (!location) return [];
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  const hours = location.hours[weekday];
  if (!hours) return [];

  const slots: Slot[] = [];
  for (let minute = hours[0]; minute + SLOT_MINUTES <= hours[1]; minute += SLOT_MINUTES) {
    const start = localToUtc(date, minute, location.timezone);
    if (start <= now) continue;
    const seed = hash(`${locationId}|${date.year}-${date.month}-${date.day}|${minute}`);
    if (seed % 100 < BUSY_PERCENT) continue;
    slots.push({
      startTime: formatLocal(start, location.timezone),
      id: timeId(start, location.timezone),
      score: (seed % 1000) / 1000,
      start,
    });
  }
  return slots;
}
