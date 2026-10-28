import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { subscriptions, users, type DbUser } from "@/lib/db/schema";
import type { PlanAction } from "@/lib/billing";

export interface ClerkProfile {
  email?: string | null;
  name?: string | null;
  imageUrl?: string | null;
}

interface ClerkUserLike {
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  image_url?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: { id: string; email_address: string }[] | null;
}

/** Map a Clerk webhook `UserJSON` to the profile columns we store. */
export function profileFromClerkJson(u: ClerkUserLike): ClerkProfile {
  const emails = u.email_addresses ?? [];
  const primary = emails.find((e) => e.id === u.primary_email_address_id) ?? emails[0];
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.username || null;
  return { email: primary?.email_address ?? null, name, imageUrl: u.image_url ?? null };
}

/**
 * Create or update a user and guarantee they have a subscription row
 * (free / active). Idempotent: safe for webhook retries and for lazy creation
 * when a request arrives before the webhook does.
 */
export async function upsertUser(clerkId: string, profile: ClerkProfile = {}): Promise<DbUser> {
  const db = getDb();
  const set: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
  if (profile.email !== undefined) set.email = profile.email;
  if (profile.name !== undefined) set.name = profile.name;
  if (profile.imageUrl !== undefined) set.imageUrl = profile.imageUrl;

  const [row] = await db
    .insert(users)
    .values({ clerkId, email: profile.email ?? null, name: profile.name ?? null, imageUrl: profile.imageUrl ?? null })
    .onConflictDoUpdate({ target: users.clerkId, set })
    .returning();

  await db.insert(subscriptions).values({ userId: row.id, plan: "free", status: "active" }).onConflictDoNothing({ target: subscriptions.userId });
  return row;
}

export async function getUserByClerkId(clerkId: string): Promise<DbUser | undefined> {
  const [row] = await getDb().select().from(users).where(eq(users.clerkId, clerkId)).limit(1);
  return row;
}

export async function deleteUserByClerkId(clerkId: string): Promise<boolean> {
  const rows = await getDb().delete(users).where(eq(users.clerkId, clerkId)).returning({ id: users.id });
  return rows.length > 0;
}

/**
 * Apply a plan decision from lib/billing.ts. Out-of-order events (older than the
 * newest one already applied) are ignored.
 */
export async function applyPlanAction(
  clerkId: string,
  action: PlanAction,
  opts: { eventAt?: Date | null; profile?: ClerkProfile } = {},
): Promise<"applied" | "ignored" | "stale"> {
  if (action.type === "ignore") return "ignored";

  const db = getDb();
  const user = (await getUserByClerkId(clerkId)) ?? (await upsertUser(clerkId, opts.profile ?? {}));
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, user.id)).limit(1);

  if (opts.eventAt && sub?.lastEventAt && opts.eventAt.getTime() < sub.lastEventAt.getTime()) return "stale";

  if (action.type === "set") {
    await db
      .insert(subscriptions)
      .values({
        userId: user.id,
        plan: action.plan,
        status: action.status,
        clerkSubscriptionId: action.clerkSubscriptionId,
        currentPeriodEnd: action.currentPeriodEnd,
        lastEventAt: opts.eventAt ?? null,
      })
      .onConflictDoUpdate({
        target: subscriptions.userId,
        set: {
          plan: action.plan,
          status: action.status,
          clerkSubscriptionId: action.clerkSubscriptionId,
          currentPeriodEnd: action.currentPeriodEnd,
          lastEventAt: opts.eventAt ?? null,
          updatedAt: new Date(),
        },
      });
    return "applied";
  }

  // downgrade
  if (action.onlyIfItemId && sub?.clerkSubscriptionId && sub.clerkSubscriptionId !== action.onlyIfItemId) {
    return "ignored"; // an old premium item ended; a newer one is stored
  }
  await db
    .insert(subscriptions)
    .values({ userId: user.id, plan: "free", status: "active", lastEventAt: opts.eventAt ?? null })
    .onConflictDoUpdate({
      target: subscriptions.userId,
      set: { plan: "free", status: "active", currentPeriodEnd: null, lastEventAt: opts.eventAt ?? null, updatedAt: new Date() },
    });
  return "applied";
}
