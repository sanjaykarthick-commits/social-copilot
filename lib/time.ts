import { TZDate } from "@date-fns/tz";

/**
 * Time handling rule: store UTC instants, render in the user's timezone, convert
 * on input. A "local" value (what the schedule picker produces) is a wall-clock
 * date + time in a named timezone; toInstant() turns it into the UTC instant.
 */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Browsers (Chromium especially) report and list some zones under their legacy IANA names.
 * We always store and show the modern name so users find their own zone in the list.
 */
const LEGACY_ZONES: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Rangoon": "Asia/Yangon",
  "Europe/Kiev": "Europe/Kyiv",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Ponape": "Pacific/Pohnpei",
};

export const normalizeTimeZone = (tz: string): string => LEGACY_ZONES[tz] ?? tz;

export function browserTimeZone(): string {
  try {
    return normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  } catch {
    return "UTC";
  }
}

/** Every zone to offer in a picker: modern names, no legacy duplicates, always including `current`. */
export function timeZoneOptions(current: string): string[] {
  let base: string[] = [];
  try {
    base = Intl.supportedValuesOf("timeZone");
  } catch {
    // very old engines: fall back to the zones we know plus the current one
  }
  const set = new Set<string>(base.map(normalizeTimeZone));
  for (const modern of Object.values(LEGACY_ZONES)) if (isValidTimeZone(modern)) set.add(modern);
  set.add("UTC");
  set.add(normalizeTimeZone(current));
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Wall-clock components in `tz` -> UTC Date. DST-correct. */
export function toInstant(parts: { year: number; month: number; day: number; hour: number; minute: number }, tz: string): Date {
  const d = new TZDate(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, tz);
  return new Date(d.getTime());
}

/** UTC Date -> wall-clock components in `tz`. */
export function fromInstant(date: Date, tz: string) {
  const d = new TZDate(date.getTime(), tz);
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() };
}

/** Calendar day key (YYYY-MM-DD) of an instant, as seen in `tz`. */
export function dayKey(date: Date, tz: string): string {
  const { year, month, day } = fromInstant(date, tz);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function formatInTz(date: Date, tz: string, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).format(date);
}

/** "5 min ago", "yesterday", "3 days ago"; older than a week shows the date in `tz`. */
export function timeAgo(date: Date, now: Date, tz: string): string {
  const s = Math.round((now.getTime() - date.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (s < 45) return "just now";
  if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
  if (s < 86_400) return rtf.format(-Math.round(s / 3600), "hour");
  if (s < 7 * 86_400) return rtf.format(-Math.round(s / 86_400), "day");
  return formatInTz(date, tz, { month: "short", day: "numeric", ...(fromInstant(date, tz).year !== fromInstant(now, tz).year ? { year: "numeric" } : {}) });
}

/** Round up to the next 15 minute boundary (the picker's granularity). */
export function ceilTo15(date: Date): Date {
  const ms = 15 * 60_000;
  return new Date(Math.ceil(date.getTime() / ms) * ms);
}
