// Date helpers. Everything here works in the device's local time zone and
// treats Monday as the first day of the week, matching the paper journal.
// Dates are passed around as ISO calendar strings (YYYY-MM-DD) so they are
// safe to store, compare and use as keys.

export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type DayKey = (typeof DAY_KEYS)[number];

export const DAY_LABELS: Record<DayKey, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export const DAY_SHORT: Record<DayKey, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number) => String(n).padStart(2, '0');

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse YYYY-MM-DD as local midnight. */
export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function isISODate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parseISODate(value).getTime());
}

export function addDays(iso: string, n: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

/** Monday of the week containing the given date. */
export function weekStartOf(date: Date | string): string {
  const d = typeof date === 'string' ? parseISODate(date) : new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offsetFromMonday = (d.getDay() + 6) % 7; // Sun=0 -> 6, Mon=1 -> 0
  d.setDate(d.getDate() - offsetFromMonday);
  return toISODate(d);
}

export function todayISO(now: Date = new Date()): string {
  return toISODate(now);
}

/** The seven dates of a week, Monday first. */
export function weekDates(weekStart: string): string[] {
  return DAY_KEYS.map((_, i) => addDays(weekStart, i));
}

export function dayKeyOf(iso: string): DayKey {
  const d = parseISODate(iso);
  return DAY_KEYS[(d.getDay() + 6) % 7];
}

export function dayIndex(key: DayKey): number {
  return DAY_KEYS.indexOf(key);
}

/** ISO-8601 week number (weeks start Monday; week 1 contains 4 January). */
export function isoWeekNumber(iso: string): number {
  const d = parseISODate(iso);
  const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = utc.getUTCDay() || 7; // Sun -> 7
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum); // nearest Thursday
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  return Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/** "16 – 22 Mar 2026", "30 Mar – 5 Apr 2026" or "29 Dec 2025 – 4 Jan 2026". */
export function formatWeekRange(weekStart: string): string {
  const a = parseISODate(weekStart);
  const b = parseISODate(addDays(weekStart, 6));
  const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  const sameYear = a.getFullYear() === b.getFullYear();
  if (sameMonth) return `${a.getDate()} – ${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
  if (sameYear) return `${a.getDate()} ${MONTHS[a.getMonth()]} – ${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
  return `${a.getDate()} ${MONTHS[a.getMonth()]} ${a.getFullYear()} – ${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
}

/** "Mon 16 Mar" */
export function formatDayHeading(iso: string): string {
  const d = parseISODate(iso);
  return `${DAY_SHORT[dayKeyOf(iso)]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "March 2026" for the month the week mostly falls in (Thursday's month). */
export function formatWeekMonth(weekStart: string): string {
  const d = parseISODate(addDays(weekStart, 3));
  const long = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${long[d.getMonth()]} ${d.getFullYear()}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}
