// Dates and times are always shown in the clinic's time zone, not the visitor's:
// someone in California booking a New York studio needs New York times.

/** Today's date at the clinic, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now = new Date()): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** YYYY-MM-DD plus n days. Pure calendar math, no time zones involved. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** "Wed, Nov 25" for a YYYY-MM-DD (a calendar date, so formatted at noon UTC to avoid shifting). */
export function formatDay(date: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T12:00:00Z`),
  );
}

/** "9:00 AM" for an ISO instant, in the clinic's time zone. */
export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
}
