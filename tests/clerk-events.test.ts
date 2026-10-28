import { eq } from "drizzle-orm";
import type { WebhookEvent } from "@clerk/nextjs/webhooks";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { handleClerkEvent } from "@/lib/clerk-events";
import { getDb } from "@/lib/db";
import { subscriptions, users } from "@/lib/db/schema";
import { getUserPlan } from "@/lib/plans";
import { hasDb, resetDb } from "./helpers/db";

const FUTURE = Date.now() + 7 * 86_400_000;

const userEvent = (type: "user.created" | "user.updated", id = "user_abc", extra: object = {}) =>
  ({
    type,
    object: "event",
    data: {
      id,
      first_name: "Asha",
      last_name: "Rao",
      username: null,
      image_url: "https://img.clerk.com/a.png",
      primary_email_address_id: "idn_1",
      email_addresses: [{ id: "idn_1", email_address: "asha@example.com" }],
      ...extra,
    },
  }) as unknown as WebhookEvent;

const itemEvent = (type: string, status: string, over: Record<string, unknown> = {}) =>
  ({
    type,
    object: "event",
    data: {
      id: "ci_prem",
      object: "commerce_subscription_item",
      status,
      period_end: FUTURE,
      plan: { slug: "premium", name: "Premium" },
      payer: { user_id: "user_abc", email: "asha@example.com", image_url: "" },
      ...over,
    },
  }) as unknown as WebhookEvent;

const subEvent = (type: string, status: string, items: unknown[]) =>
  ({
    type,
    object: "event",
    data: { id: "sub_1", object: "commerce_subscription", status, payer: { user_id: "user_abc", email: "a@b.c", image_url: "" }, items },
  }) as unknown as WebhookEvent;

async function planOf(clerkId = "user_abc") {
  const db = getDb();
  const [u] = await db.select().from(users).where(eq(users.clerkId, clerkId));
  return getUserPlan(u.id);
}

describe.skipIf(!hasDb)("Clerk webhook -> database", () => {
  beforeEach(resetDb);
  afterAll(resetDb);

  it("user.created inserts a user and a free/active subscription", async () => {
    await handleClerkEvent(userEvent("user.created"));
    const db = getDb();
    const [u] = await db.select().from(users).where(eq(users.clerkId, "user_abc"));
    expect(u).toMatchObject({ email: "asha@example.com", name: "Asha Rao", imageUrl: "https://img.clerk.com/a.png", timezone: "UTC" });
    const [s] = await db.select().from(subscriptions).where(eq(subscriptions.userId, u.id));
    expect(s).toMatchObject({ plan: "free", status: "active" });
  });

  it("stores the Clerk id as text, separate from the uuid primary key", async () => {
    await handleClerkEvent(userEvent("user.created", "user_2abcDEFghi"));
    const [u] = await getDb().select().from(users);
    expect(u.clerkId).toBe("user_2abcDEFghi");
    expect(u.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("is idempotent: a retried user.created does not duplicate rows", async () => {
    await handleClerkEvent(userEvent("user.created"));
    await handleClerkEvent(userEvent("user.created"));
    const db = getDb();
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(subscriptions)).toHaveLength(1);
  });

  it("user.updated changes profile fields", async () => {
    await handleClerkEvent(userEvent("user.created"));
    await handleClerkEvent(userEvent("user.updated", "user_abc", { first_name: "Asha-Updated" }));
    const [u] = await getDb().select().from(users);
    expect(u.name).toBe("Asha-Updated Rao");
  });

  it("user.deleted cascades to the subscription", async () => {
    await handleClerkEvent(userEvent("user.created"));
    await handleClerkEvent({ type: "user.deleted", object: "event", data: { id: "user_abc", deleted: true, object: "user" } } as unknown as WebhookEvent);
    const db = getDb();
    expect(await db.select().from(users)).toHaveLength(0);
    expect(await db.select().from(subscriptions)).toHaveLength(0);
  });

  it("upgrade: an active premium item flips the plan to premium with no manual DB edit", async () => {
    await handleClerkEvent(userEvent("user.created"));
    expect(await planOf()).toBe("free");
    await handleClerkEvent(itemEvent("subscriptionItem.active", "active"), 1000);
    expect(await planOf()).toBe("premium");
    const [s] = await getDb().select().from(subscriptions);
    expect(s).toMatchObject({ plan: "premium", status: "active", clerkSubscriptionId: "ci_prem" });
  });

  it("creates the user if a billing event arrives before user.created", async () => {
    await handleClerkEvent(itemEvent("subscriptionItem.active", "active"), 1000);
    expect(await planOf()).toBe("premium");
  });

  it("cancel keeps premium until the paid period ends, then ended returns to free", async () => {
    await handleClerkEvent(userEvent("user.created"));
    await handleClerkEvent(itemEvent("subscriptionItem.active", "active"), 1000);
    await handleClerkEvent(itemEvent("subscriptionItem.canceled", "canceled"), 2000);
    expect(await planOf()).toBe("premium");
    await handleClerkEvent(itemEvent("subscriptionItem.ended", "ended", { period_end: Date.now() - 1000 }), 3000);
    expect(await planOf()).toBe("free");
  });

  it("ignores stale (older) events", async () => {
    await handleClerkEvent(userEvent("user.created"));
    await handleClerkEvent(itemEvent("subscriptionItem.active", "active"), 5000);
    await handleClerkEvent(itemEvent("subscriptionItem.ended", "ended", { period_end: Date.now() - 1000 }), 4000); // older
    expect(await planOf()).toBe("premium");
  });

  it("a free-plan item event cannot downgrade a paying user", async () => {
    await handleClerkEvent(userEvent("user.created"));
    await handleClerkEvent(itemEvent("subscriptionItem.active", "active"), 1000);
    await handleClerkEvent(itemEvent("subscriptionItem.ended", "ended", { id: "ci_free", plan: { slug: "free" } }), 2000);
    expect(await planOf()).toBe("premium");
  });

  it("an ended OLD premium item does not downgrade a newer premium item", async () => {
    await handleClerkEvent(userEvent("user.created"));
    await handleClerkEvent(itemEvent("subscriptionItem.active", "active", { id: "ci_new" }), 1000);
    await handleClerkEvent(itemEvent("subscriptionItem.ended", "ended", { id: "ci_old", period_end: Date.now() - 1000 }), 2000);
    expect(await planOf()).toBe("premium");
  });

  it("subscription.* events are authoritative over the item list", async () => {
    await handleClerkEvent(userEvent("user.created"));
    await handleClerkEvent(subEvent("subscription.active", "active", [{ id: "ci_prem", status: "active", plan: { slug: "premium" }, period_end: FUTURE }]), 1000);
    expect(await planOf()).toBe("premium");
    await handleClerkEvent(subEvent("subscription.updated", "ended", [{ id: "ci_prem", status: "ended", plan: { slug: "premium" }, period_end: Date.now() - 1 }]), 2000);
    expect(await planOf()).toBe("free");
  });

  it("organization payers (no user_id) are ignored, not crashed on", async () => {
    const evt = { type: "subscription.active", object: "event", data: { id: "sub_org", payer: { organization_id: "org_1" }, items: [] } } as unknown as WebhookEvent;
    await expect(handleClerkEvent(evt)).resolves.toContain("no user payer");
  });

  it("unknown event types are acknowledged", async () => {
    await expect(handleClerkEvent({ type: "session.created", object: "event", data: {} } as unknown as WebhookEvent)).resolves.toContain("ignored");
  });
});
