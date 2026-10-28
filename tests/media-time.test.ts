import { describe, expect, it } from "vitest";
import { isTrustedMediaUrl } from "@/lib/media";
import { ceilTo15, dayKey, fromInstant, isValidTimeZone, normalizeTimeZone, timeZoneOptions, toInstant } from "@/lib/time";

describe("isTrustedMediaUrl (SSRF guard)", () => {
  const endpoint = "https://ik.imagekit.io/acme";
  it("accepts files under our ImageKit endpoint", () => {
    expect(isTrustedMediaUrl("https://ik.imagekit.io/acme/photo.jpg", endpoint)).toBe(true);
    expect(isTrustedMediaUrl("https://ik.imagekit.io/acme/a/b/c.mp4?tr=w-300", endpoint)).toBe(true);
    expect(isTrustedMediaUrl("https://ik.imagekit.io/acme/photo.jpg", `${endpoint}/`)).toBe(true);
  });
  it("rejects other hosts, look-alike hosts and other accounts' paths", () => {
    expect(isTrustedMediaUrl("https://evil.example/acme/x.jpg", endpoint)).toBe(false);
    expect(isTrustedMediaUrl("https://ik.imagekit.io.evil.example/acme/x.jpg", endpoint)).toBe(false);
    expect(isTrustedMediaUrl("https://ik.imagekit.io/acmeevil/x.jpg", endpoint)).toBe(false);
    expect(isTrustedMediaUrl("https://ik.imagekit.io/other/x.jpg", endpoint)).toBe(false);
  });
  it("rejects http, userinfo tricks, internal addresses and garbage", () => {
    expect(isTrustedMediaUrl("http://ik.imagekit.io/acme/x.jpg", endpoint)).toBe(false);
    expect(isTrustedMediaUrl("https://ik.imagekit.io@evil.example/acme/x.jpg", endpoint)).toBe(false);
    expect(isTrustedMediaUrl("http://169.254.169.254/latest/meta-data", endpoint)).toBe(false);
    expect(isTrustedMediaUrl("not a url", endpoint)).toBe(false);
  });
});

describe("timezones", () => {
  it("validates IANA names", () => {
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });

  it("converts a wall-clock time in a zone to the right UTC instant", () => {
    // IST is UTC+5:30 with no DST.
    expect(toInstant({ year: 2026, month: 11, day: 3, hour: 9, minute: 30 }, "Asia/Kolkata").toISOString()).toBe("2026-11-03T04:00:00.000Z");
    expect(toInstant({ year: 2026, month: 11, day: 3, hour: 9, minute: 30 }, "UTC").toISOString()).toBe("2026-11-03T09:30:00.000Z");
  });

  it("is DST-correct: 9am New York is 13:00Z in summer and 14:00Z in winter", () => {
    expect(toInstant({ year: 2026, month: 7, day: 1, hour: 9, minute: 0 }, "America/New_York").toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(toInstant({ year: 2026, month: 12, day: 1, hour: 9, minute: 0 }, "America/New_York").toISOString()).toBe("2026-12-01T14:00:00.000Z");
  });

  it("round-trips instant <-> wall clock", () => {
    const d = new Date("2026-03-29T22:15:00Z");
    for (const tz of ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Australia/Sydney", "Pacific/Auckland"]) {
      const parts = fromInstant(d, tz);
      expect(toInstant(parts, tz).toISOString()).toBe(d.toISOString());
    }
  });

  it("groups by the calendar day the user sees, not the UTC day", () => {
    const lateUtc = new Date("2026-11-03T22:00:00Z");
    expect(dayKey(lateUtc, "UTC")).toBe("2026-11-03");
    expect(dayKey(lateUtc, "Asia/Kolkata")).toBe("2026-11-04"); // 03:30 next day in IST
    expect(dayKey(lateUtc, "America/Los_Angeles")).toBe("2026-11-03");
  });

  it("rounds up to the next quarter hour", () => {
    expect(ceilTo15(new Date("2026-11-03T10:01:00Z")).toISOString()).toBe("2026-11-03T10:15:00.000Z");
    expect(ceilTo15(new Date("2026-11-03T10:15:00Z")).toISOString()).toBe("2026-11-03T10:15:00.000Z");
  });
});

describe("timezone picker options", () => {
  it("offers modern names for zones browsers list under legacy names", () => {
    const list = timeZoneOptions("UTC");
    expect(list).toContain("Asia/Kolkata");
    expect(list).toContain("Europe/Kyiv");
    expect(list).toContain("Asia/Kathmandu");
    expect(list).not.toContain("Asia/Calcutta");
    expect(list).not.toContain("Europe/Kiev");
  });
  it("always contains the current zone, even a legacy spelling (normalised) or one the engine omits", () => {
    expect(timeZoneOptions("Asia/Calcutta")).toContain("Asia/Kolkata");
    expect(timeZoneOptions("Mars/Olympus")).toContain("Mars/Olympus");
  });
  it("is deduplicated, sorted, and every entry (except the exotic current) is a valid zone", () => {
    const list = timeZoneOptions("America/New_York");
    expect(new Set(list).size).toBe(list.length);
    expect([...list].sort((a, b) => a.localeCompare(b))).toEqual(list);
    expect(list.filter((z) => !isValidTimeZone(z))).toEqual([]);
    expect(list).toContain("America/New_York");
    expect(list).toContain("UTC");
  });
  it("normalises legacy names and leaves modern ones alone", () => {
    expect(normalizeTimeZone("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(normalizeTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(normalizeTimeZone("America/New_York")).toBe("America/New_York");
  });
});
