import { fromInstant, toInstant } from "@/lib/time";

/**
 * Calendar date math on plain calendar days (no timezones involved), plus the few
 * conversions to and from real instants. Weeks start on Monday.
 */
export interface Ymd {
  year: number;
  month: number; // 1-12
  day: number;
}

export type CalendarView = "month" | "week" | "day";

const utc = (d: Ymd) => new Date(Date.UTC(d.year, d.month - 1, d.day));
const fromUtc = (d: Date): Ymd => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });

export const ymdKey = (d: Ymd) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

export function parseYmdKey(key: string): Ymd {
  const [year, month, day] = key.split("-").map(Number);
  return { year, month, day };
}

export function addDays(d: Ymd, n: number): Ymd {
  const x = utc(d);
  x.setUTCDate(x.getUTCDate() + n);
  return fromUtc(x);
}

export function addMonths(d: Ymd, n: number): Ymd {
  const x = new Date(Date.UTC(d.year, d.month - 1 + n, 1));
  // Clamp so Jan 31 + 1 month is Feb 28/29, not Mar 3.
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  return { year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: Math.min(d.day, last) };
}

/** 0 = Monday ... 6 = Sunday */
export function weekdayIndex(d: Ymd): number {
  return (utc(d).getUTCDay() + 6) % 7;
}

export const startOfWeek = (d: Ymd): Ymd => addDays(d, -weekdayIndex(d));

export function weekDays(d: Ymd): Ymd[] {
  const start = startOfWeek(d);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** The 6x7 grid of days a month view shows (leading/trailing days from neighbouring months included). */
export function monthGrid(d: Ymd): Ymd[] {
  const first = { year: d.year, month: d.month, day: 1 };
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export const sameDay = (a: Ymd, b: Ymd) => a.year === b.year && a.month === b.month && a.day === b.day;
export const sameMonth = (a: Ymd, b: Ymd) => a.year === b.year && a.month === b.month;

/** The visible days for a view. */
export function visibleDays(view: CalendarView, anchor: Ymd): Ymd[] {
  if (view === "month") return monthGrid(anchor);
  if (view === "week") return weekDays(anchor);
  return [anchor];
}

/** [from, to) as real instants: the start of the first visible day to the start of the day after the last one. */
export function rangeFor(view: CalendarView, anchor: Ymd, tz: string): { from: Date; to: Date } {
  const days = visibleDays(view, anchor);
  const first = days[0];
  const after = addDays(days[days.length - 1], 1);
  return {
    from: toInstant({ ...first, hour: 0, minute: 0 }, tz),
    to: toInstant({ ...after, hour: 0, minute: 0 }, tz),
  };
}

export function shiftAnchor(view: CalendarView, anchor: Ymd, dir: -1 | 1): Ymd {
  if (view === "month") return addMonths(anchor, dir);
  if (view === "week") return addDays(anchor, 7 * dir);
  return addDays(anchor, dir);
}

/** Which calendar day (in `tz`) does this instant fall on? */
export const ymdOf = (date: Date, tz: string): Ymd => {
  const p = fromInstant(date, tz);
  return { year: p.year, month: p.month, day: p.day };
};

/**
 * Where a dragged post lands.
 *  - Month view: keep the wall-clock time of day, change the day.
 *  - Week/day view: take the hour of the slot, keep the original minutes.
 * Working in wall-clock terms means a 9:00 post is still 9:00 after crossing a DST change.
 */
export function dropTarget(original: Date, day: Ymd, hour: number | null, tz: string): Date {
  const o = fromInstant(original, tz);
  return toInstant({ ...day, hour: hour ?? o.hour, minute: o.minute }, tz);
}

export function titleFor(view: CalendarView, anchor: Ymd): string {
  const fmt = (d: Ymd, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(utc(d));
  if (view === "month") return fmt(anchor, { month: "long", year: "numeric" });
  if (view === "day") return fmt(anchor, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  // Intl cannot format "day + year" without a month, so the range is composed by hand.
  const days = weekDays(anchor);
  const a = days[0];
  const b = days[6];
  const month = (x: Ymd) => fmt(x, { month: "short" });
  if (a.year !== b.year) return `${month(a)} ${a.day}, ${a.year} – ${month(b)} ${b.day}, ${b.year}`;
  if (a.month !== b.month) return `${month(a)} ${a.day} – ${month(b)} ${b.day}, ${b.year}`;
  return `${month(a)} ${a.day} – ${b.day}, ${b.year}`;
}
