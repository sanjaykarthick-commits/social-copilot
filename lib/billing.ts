import type { PlanKey } from "@/lib/constants";

/**
 * Pure logic that turns Clerk Billing webhook payloads into our plan state.
 * Kept free of I/O so it is unit-tested (tests/billing.test.ts).
 *
 * Clerk payload facts (verified against @clerk/backend types):
 *  - subscriptionItem.* : data.plan.slug, data.status, data.period_end (ms), data.payer.user_id
 *  - subscription.*     : data.status, data.items[] (same item shape), data.payer.user_id
 *  - item status: abandoned | active | canceled | ended | expired | incomplete | past_due | upcoming
 */
export interface ClerkBillingItem {
  id?: string;
  status?: string;
  plan?: { slug?: string | null } | null;
  period_end?: number | null;
}

export type PlanAction =
  | { type: "set"; plan: PlanKey; status: string; currentPeriodEnd: Date | null; clerkSubscriptionId: string | null }
  | { type: "downgrade"; reason: string; onlyIfItemId?: string }
  | { type: "ignore"; reason: string };

/** The single paid plan slug. Never "pro". */
export const PREMIUM_SLUG = "premium";

export function planFromSlug(slug: string | null | undefined): PlanKey {
  return slug?.trim().toLowerCase() === PREMIUM_SLUG ? "premium" : "free";
}

/** Clerk sends ms; tolerate seconds just in case. */
export function toDate(v: number | null | undefined): Date | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return new Date(v < 1e11 ? v * 1000 : v);
}

/**
 * Does a subscription item currently entitle the user to its plan?
 * - active / past_due: yes (past_due keeps access while Clerk retries payment)
 * - canceled: yes until the paid period ends
 * - ended / expired / abandoned / incomplete / upcoming / unknown: no
 */
export function itemEntitles(status: string | undefined, periodEnd: Date | null, now: Date = new Date()): boolean {
  switch (status) {
    case "active":
    case "past_due":
      return true;
    case "canceled":
      return periodEnd !== null && periodEnd.getTime() > now.getTime();
    default:
      return false;
  }
}

/** subscriptionItem.* events. Free-plan items never change state (they can arrive out of order). */
export function resolveFromItem(item: ClerkBillingItem, now: Date = new Date()): PlanAction {
  const plan = planFromSlug(item.plan?.slug);
  if (plan !== "premium") return { type: "ignore", reason: "non-premium item" };

  const periodEnd = toDate(item.period_end);
  if (itemEntitles(item.status, periodEnd, now)) {
    return {
      type: "set",
      plan: "premium",
      status: item.status ?? "active",
      currentPeriodEnd: periodEnd,
      clerkSubscriptionId: item.id ?? null,
    };
  }
  if (item.status === "upcoming" || item.status === "incomplete") {
    return { type: "ignore", reason: `premium item ${item.status}` };
  }
  // ended / expired / abandoned / canceled-after-period-end
  return { type: "downgrade", reason: `premium item ${item.status}`, onlyIfItemId: item.id };
}

/** subscription.* events carry the full item list, so they are authoritative. */
export function resolveFromSubscription(
  sub: { id?: string; items?: ClerkBillingItem[] | null },
  now: Date = new Date(),
): PlanAction {
  const items = sub.items ?? [];
  const entitled = items
    .filter((i) => planFromSlug(i.plan?.slug) === "premium")
    .filter((i) => itemEntitles(i.status, toDate(i.period_end), now));

  if (entitled.length === 0) return { type: "downgrade", reason: "no entitled premium item" };

  // Prefer a healthy active item over past_due / canceled.
  const best = entitled.find((i) => i.status === "active") ?? entitled[0];
  return {
    type: "set",
    plan: "premium",
    status: best.status ?? "active",
    currentPeriodEnd: toDate(best.period_end),
    clerkSubscriptionId: best.id ?? sub.id ?? null,
  };
}

/** What plan does a stored subscription row grant right now? */
export function effectivePlan(
  sub: { plan: string; status: string; currentPeriodEnd: Date | null } | undefined | null,
  now: Date = new Date(),
): PlanKey {
  if (!sub || sub.plan !== "premium") return "free";
  return itemEntitles(sub.status, sub.currentPeriodEnd, now) ? "premium" : "free";
}
