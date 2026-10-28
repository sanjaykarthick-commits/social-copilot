import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  dropTarget,
  monthGrid,
  parseYmdKey,
  rangeFor,
  shiftAnchor,
  startOfWeek,
  titleFor,
  visibleDays,
  weekdayIndex,
  weekDays,
  ymdKey,
  ymdOf,
} from "@/lib/calendar";

const d = (year: number, month: number, day: number) => ({ year, month, day });

describe("day arithmetic", () => {
  it("adds days across month and year boundaries and leap days", () => {
    expect(addDays(d(2026, 1, 31), 1)).toEqual(d(2026, 2, 1));
    expect(addDays(d(2026, 12, 31), 1)).toEqual(d(2027, 1, 1));
    expect(addDays(d(2028, 2, 28), 1)).toEqual(d(2028, 2, 29));
    expect(addDays(d(2026, 3, 1), -1)).toEqual(d(2026, 2, 28));
  });
  it("clamps month arithmetic (Jan 31 + 1 month is Feb 28)", () => {
    expect(addMonths(d(2026, 1, 31), 1)).toEqual(d(2026, 2, 28));
    expect(addMonths(d(2028, 1, 31), 1)).toEqual(d(2028, 2, 29));
    expect(addMonths(d(2026, 12, 15), 1)).toEqual(d(2027, 1, 15));
    expect(addMonths(d(2026, 1, 15), -1)).toEqual(d(2025, 12, 15));
  });
  it("round-trips keys", () => {
    expect(ymdKey(d(2026, 3, 5))).toBe("2026-03-05");
    expect(parseYmdKey("2026-03-05")).toEqual(d(2026, 3, 5));
  });
});

describe("weeks start on Monday", () => {
  it("numbers weekdays Mon=0..Sun=6", () => {
    expect(weekdayIndex(d(2026, 10, 26))).toBe(0); // Monday
    expect(weekdayIndex(d(2026, 10, 27))).toBe(1);
    expect(weekdayIndex(d(2026, 11, 1))).toBe(6); // Sunday
  });
  it("finds the start of the week for any day", () => {
    expect(startOfWeek(d(2026, 10, 27))).toEqual(d(2026, 10, 26));
    expect(startOfWeek(d(2026, 11, 1))).toEqual(d(2026, 10, 26));
    expect(startOfWeek(d(2026, 10, 26))).toEqual(d(2026, 10, 26));
  });
  it("lists seven consecutive days", () => {
    const w = weekDays(d(2026, 10, 29));
    expect(w).toHaveLength(7);
    expect(w[0]).toEqual(d(2026, 10, 26));
    expect(w[6]).toEqual(d(2026, 11, 1));
  });
});

describe("month grid", () => {
  it("is 42 cells starting on the Monday on or before the 1st", () => {
    const g = monthGrid(d(2026, 10, 15)); // Oct 1 2026 is a Thursday
    expect(g).toHaveLength(42);
    expect(g[0]).toEqual(d(2026, 9, 28));
    expect(g[3]).toEqual(d(2026, 10, 1));
    expect(g[41]).toEqual(d(2026, 11, 8));
  });
  it("starts exactly on the 1st when the month begins on a Monday", () => {
    expect(monthGrid(d(2026, 6, 10))[0]).toEqual(d(2026, 6, 1)); // Jun 1 2026 is a Monday
  });
  it("visibleDays matches each view", () => {
    expect(visibleDays("month", d(2026, 10, 15))).toHaveLength(42);
    expect(visibleDays("week", d(2026, 10, 15))).toHaveLength(7);
    expect(visibleDays("day", d(2026, 10, 15))).toEqual([d(2026, 10, 15)]);
  });
});

describe("query ranges are real instants in the user's timezone", () => {
  it("a UTC week is [Mon 00:00Z, next Mon 00:00Z)", () => {
    const r = rangeFor("week", d(2026, 10, 28), "UTC");
    expect(r.from.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-11-02T00:00:00.000Z");
  });
  it("shifts by the zone offset so late-night posts land on the right local day", () => {
    const r = rangeFor("day", d(2026, 11, 4), "Asia/Kolkata");
    expect(r.from.toISOString()).toBe("2026-11-03T18:30:00.000Z"); // IST midnight
    expect(r.to.toISOString()).toBe("2026-11-04T18:30:00.000Z");
  });
  it("handles a 23-hour DST day correctly", () => {
    // US DST starts 2026-03-08 in New York: that local day is only 23 hours long.
    const r = rangeFor("day", d(2026, 3, 8), "America/New_York");
    expect((r.to.getTime() - r.from.getTime()) / 3_600_000).toBe(23);
  });
  it("ymdOf buckets an instant by the viewer's local day", () => {
    const t = new Date("2026-11-03T22:00:00Z");
    expect(ymdOf(t, "UTC")).toEqual(d(2026, 11, 3));
    expect(ymdOf(t, "Asia/Kolkata")).toEqual(d(2026, 11, 4));
  });
});

describe("dragging a post", () => {
  it("month view keeps the wall-clock time and changes the day", () => {
    const original = new Date("2026-10-27T04:00:00Z"); // 09:30 IST
    const out = dropTarget(original, d(2026, 10, 30), null, "Asia/Kolkata");
    expect(out.toISOString()).toBe("2026-10-30T04:00:00.000Z");
  });
  it("week/day view takes the slot's hour and keeps the minutes", () => {
    const original = new Date("2026-10-27T04:15:00Z"); // 09:45 IST
    const out = dropTarget(original, d(2026, 10, 28), 14, "Asia/Kolkata");
    expect(out.toISOString()).toBe("2026-10-28T09:15:00.000Z"); // 14:45 IST (UTC+5:30)
  });
  it("a 9:00 post is still 9:00 local after crossing the DST change", () => {
    const original = new Date("2026-03-06T14:00:00Z"); // 09:00 EST (UTC-5)
    const out = dropTarget(original, d(2026, 3, 9), null, "America/New_York"); // after DST starts (UTC-4)
    expect(out.toISOString()).toBe("2026-03-09T13:00:00.000Z"); // 09:00 EDT
  });
});

describe("navigation and titles", () => {
  it("shifts by a month, week or day", () => {
    expect(shiftAnchor("month", d(2026, 1, 31), 1)).toEqual(d(2026, 2, 28));
    expect(shiftAnchor("week", d(2026, 10, 27), 1)).toEqual(d(2026, 11, 3));
    expect(shiftAnchor("day", d(2026, 10, 27), -1)).toEqual(d(2026, 10, 26));
  });
  it("titles each view", () => {
    expect(titleFor("month", d(2026, 10, 27))).toBe("October 2026");
    expect(titleFor("day", d(2026, 10, 27))).toBe("Tuesday, October 27, 2026");
    expect(titleFor("week", d(2026, 10, 28))).toBe("Oct 26 – Nov 1, 2026");
    expect(titleFor("week", d(2026, 10, 14))).toBe("Oct 12 – 18, 2026");
    expect(titleFor("week", d(2026, 12, 30))).toBe("Dec 28, 2026 – Jan 3, 2027");
  });
});
