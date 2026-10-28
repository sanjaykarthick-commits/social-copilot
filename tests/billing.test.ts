import { describe, expect, it } from "vitest";
import {
  effectivePlan,
  itemEntitles,
  planFromSlug,
  resolveFromItem,
  resolveFromSubscription,
  toDate,
} from "@/lib/billing";

const NOW = new Date("2026-10-27T12:00:00Z");
const FUTURE = NOW.getTime() + 7 * 86_400_000;
const PAST = NOW.getTime() - 86_400_000;

describe("planFromSlug", () => {
  it("maps only 'premium' to premium", () => {
    expect(planFromSlug("premium")).toBe("premium");
    expect(planFromSlug(" Premium ")).toBe("premium");
  });
  it("maps everything else (including the legacy 'pro') to free", () => {
    expect(planFromSlug("pro")).toBe("free");
    expect(planFromSlug("free")).toBe("free");
    expect(planFromSlug(undefined)).toBe("free");
    expect(planFromSlug(null)).toBe("free");
  });
});

describe("toDate", () => {
  it("reads milliseconds and tolerates seconds", () => {
    expect(toDate(1_800_000_000_000)?.toISOString()).toBe("2027-01-15T08:00:00.000Z");
    expect(toDate(1_800_000_000)?.toISOString()).toBe("2027-01-15T08:00:00.000Z");
    expect(toDate(null)).toBeNull();
  });
});

describe("itemEntitles", () => {
  it("entitles active and past_due", () => {
    expect(itemEntitles("active", null, NOW)).toBe(true);
    expect(itemEntitles("past_due", null, NOW)).toBe(true);
  });
  it("entitles canceled only until the period ends", () => {
    expect(itemEntitles("canceled", new Date(FUTURE), NOW)).toBe(true);
    expect(itemEntitles("canceled", new Date(PAST), NOW)).toBe(false);
    expect(itemEntitles("canceled", null, NOW)).toBe(false);
  });
  it("never entitles ended / expired / abandoned / incomplete / upcoming / unknown", () => {
    for (const s of ["ended", "expired", "abandoned", "incomplete", "upcoming", "weird", undefined]) {
      expect(itemEntitles(s, new Date(FUTURE), NOW)).toBe(false);
    }
  });
});

describe("resolveFromItem", () => {
  it("sets premium for an active premium item", () => {
    const a = resolveFromItem({ id: "ci_1", status: "active", plan: { slug: "premium" }, period_end: FUTURE }, NOW);
    expect(a).toMatchObject({ type: "set", plan: "premium", status: "active", clerkSubscriptionId: "ci_1" });
  });
  it("keeps premium for a canceled item inside its paid period", () => {
    const a = resolveFromItem({ id: "ci_1", status: "canceled", plan: { slug: "premium" }, period_end: FUTURE }, NOW);
    expect(a).toMatchObject({ type: "set", plan: "premium", status: "canceled" });
  });
  it("downgrades when a premium item ends, scoped to that item", () => {
    const a = resolveFromItem({ id: "ci_1", status: "ended", plan: { slug: "premium" }, period_end: PAST }, NOW);
    expect(a).toEqual({ type: "downgrade", reason: "premium item ended", onlyIfItemId: "ci_1" });
  });
  it("ignores free items so out-of-order events cannot downgrade a paying user", () => {
    expect(resolveFromItem({ id: "ci_0", status: "active", plan: { slug: "free" } }, NOW).type).toBe("ignore");
    expect(resolveFromItem({ id: "ci_0", status: "ended", plan: { slug: "free" } }, NOW).type).toBe("ignore");
  });
  it("ignores an upcoming premium item (not yet paid for)", () => {
    expect(resolveFromItem({ id: "ci_2", status: "upcoming", plan: { slug: "premium" } }, NOW).type).toBe("ignore");
  });
  it("treats a legacy 'pro' slug as a non-premium plan", () => {
    expect(resolveFromItem({ id: "ci_3", status: "active", plan: { slug: "pro" } }, NOW).type).toBe("ignore");
  });
});

describe("resolveFromSubscription", () => {
  it("sets premium when any premium item is entitled", () => {
    const a = resolveFromSubscription(
      {
        id: "sub_1",
        items: [
          { id: "ci_free", status: "ended", plan: { slug: "free" } },
          { id: "ci_prem", status: "active", plan: { slug: "premium" }, period_end: FUTURE },
        ],
      },
      NOW,
    );
    expect(a).toMatchObject({ type: "set", plan: "premium", clerkSubscriptionId: "ci_prem" });
  });
  it("downgrades when no premium item is entitled", () => {
    const a = resolveFromSubscription(
      { id: "sub_1", items: [{ id: "ci_prem", status: "ended", plan: { slug: "premium" }, period_end: PAST }] },
      NOW,
    );
    expect(a.type).toBe("downgrade");
  });
  it("downgrades for an empty item list", () => {
    expect(resolveFromSubscription({ id: "sub_1", items: [] }, NOW).type).toBe("downgrade");
  });
  it("prefers an active item over a canceled one", () => {
    const a = resolveFromSubscription(
      {
        items: [
          { id: "old", status: "canceled", plan: { slug: "premium" }, period_end: FUTURE },
          { id: "new", status: "active", plan: { slug: "premium" }, period_end: FUTURE },
        ],
      },
      NOW,
    );
    expect(a).toMatchObject({ type: "set", clerkSubscriptionId: "new", status: "active" });
  });
});

describe("effectivePlan", () => {
  it("is free without a row or on the free plan", () => {
    expect(effectivePlan(undefined, NOW)).toBe("free");
    expect(effectivePlan({ plan: "free", status: "active", currentPeriodEnd: null }, NOW)).toBe("free");
  });
  it("is premium while entitled, free after the canceled period lapses", () => {
    expect(effectivePlan({ plan: "premium", status: "active", currentPeriodEnd: null }, NOW)).toBe("premium");
    expect(effectivePlan({ plan: "premium", status: "canceled", currentPeriodEnd: new Date(FUTURE) }, NOW)).toBe("premium");
    expect(effectivePlan({ plan: "premium", status: "canceled", currentPeriodEnd: new Date(PAST) }, NOW)).toBe("free");
  });
});
