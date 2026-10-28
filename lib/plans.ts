import { and, count, eq, gte, ne } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { aiUsage, posts, socialAccounts, subscriptions } from "@/lib/db/schema";
import type { PlanKey } from "@/lib/constants";
import { effectivePlan } from "@/lib/billing";
import { AppError, planLimit } from "@/lib/errors";

export type ImageEditTool = "bgremove" | "retouch" | "upscale" | "variation";

/** The single source of truth for plan limits. UI and every gated API route use these helpers. */
export const PLAN_LIMITS = {
  free: {
    accounts: 2,
    monthlyPosts: 10,
    autoReply: false,
    aiCaptionsPerDay: 10,
    imageEditTools: ["bgremove", "retouch"] as ImageEditTool[],
  },
  premium: {
    accounts: 5,
    monthlyPosts: Infinity,
    autoReply: true,
    aiCaptionsPerDay: 200,
    imageEditTools: ["bgremove", "retouch", "upscale", "variation"] as ImageEditTool[],
  },
} as const;

export { PLAN_LABEL } from "@/lib/plans-labels";
import { PLAN_LABEL } from "@/lib/plans-labels";

/** Max AI calls per minute for any plan (abuse / cost guard). */
export const AI_BURST_LIMIT = 10;

export function limitsFor(plan: PlanKey) {
  return PLAN_LIMITS[plan];
}

export function startOfMonthUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Resolve the user's plan. Clerk's own billing state (session `has`) wins when it
 * says premium, so a missed webhook can never leave a paying user on Free; the DB
 * row is then healed. Otherwise the DB row decides.
 */
export async function getUserPlan(
  userId: string,
  opts: { clerkHas?: (params: { plan: string }) => boolean } = {},
): Promise<PlanKey> {
  const db = getDb();
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1);
  const plan = effectivePlan(sub);
  if (plan === "premium") return "premium";

  let clerkPremium = false;
  try {
    clerkPremium = opts.clerkHas?.({ plan: "premium" }) === true;
  } catch {
    clerkPremium = false;
  }
  if (clerkPremium) {
    await db
      .insert(subscriptions)
      .values({ userId, plan: "premium", status: "active" })
      .onConflictDoUpdate({ target: subscriptions.userId, set: { plan: "premium", status: "active", updatedAt: new Date() } });
    return "premium";
  }
  return "free";
}

export interface Usage {
  accounts: number;
  monthlyPosts: number;
  aiCaptionsToday: number;
}

export async function getUsage(userId: string, now: Date = new Date()): Promise<Usage> {
  const db = getDb();
  const [acc] = await db
    .select({ n: count() })
    .from(socialAccounts)
    .where(and(eq(socialAccounts.userId, userId), ne(socialAccounts.status, "revoked")));
  const [mp] = await db
    .select({ n: count() })
    .from(posts)
    .where(and(eq(posts.userId, userId), gte(posts.queuedAt, startOfMonthUtc(now))));
  const [ai] = await db
    .select({ n: count() })
    .from(aiUsage)
    .where(and(eq(aiUsage.userId, userId), eq(aiUsage.kind, "caption"), gte(aiUsage.createdAt, new Date(now.getTime() - 86_400_000))));
  return { accounts: acc?.n ?? 0, monthlyPosts: mp?.n ?? 0, aiCaptionsToday: ai?.n ?? 0 };
}

export async function assertCanConnectAccount(userId: string, plan: PlanKey) {
  const { accounts } = await getUsage(userId);
  const max = PLAN_LIMITS[plan].accounts;
  if (accounts >= max) {
    throw planLimit(`Your ${PLAN_LABEL[plan]} plan allows ${max} connected accounts. Upgrade to connect more.`, {
      limit: "accounts",
      max,
      plan,
    });
  }
}

export async function assertCanQueuePosts(userId: string, plan: PlanKey, adding = 1) {
  const max = PLAN_LIMITS[plan].monthlyPosts;
  if (!Number.isFinite(max)) return;
  const { monthlyPosts } = await getUsage(userId);
  if (monthlyPosts + adding > max) {
    throw planLimit(`Your ${PLAN_LABEL[plan]} plan allows ${max} posts per month. Upgrade for unlimited posts.`, {
      limit: "monthlyPosts",
      max,
      plan,
    });
  }
}

export function assertAutoReplyAllowed(plan: PlanKey) {
  if (!PLAN_LIMITS[plan].autoReply) {
    throw planLimit("Auto-reply is a Premium feature. Upgrade to turn it on.", { limit: "autoReply", plan });
  }
}

export function assertImageToolAllowed(plan: PlanKey, tool: ImageEditTool) {
  if (!(PLAN_LIMITS[plan].imageEditTools as readonly ImageEditTool[]).includes(tool)) {
    throw planLimit("This image tool is part of the Premium plan.", { limit: "imageEditTools", tool, plan });
  }
}

/** Throws if the user is over the burst limit or their plan's daily AI limit; otherwise records the call. */
export async function consumeAiQuota(userId: string, plan: PlanKey, kind: "caption" | "reply" | "image", now: Date = new Date()) {
  const db = getDb();
  const [burst] = await db
    .select({ n: count() })
    .from(aiUsage)
    .where(and(eq(aiUsage.userId, userId), gte(aiUsage.createdAt, new Date(now.getTime() - 60_000))));
  if ((burst?.n ?? 0) >= AI_BURST_LIMIT) {
    throw new AppError("RATE_LIMITED", "You're going a bit fast. Wait a minute and try again.", 429);
  }
  if (kind === "caption") {
    const { aiCaptionsToday } = await getUsage(userId, now);
    const max = PLAN_LIMITS[plan].aiCaptionsPerDay;
    if (aiCaptionsToday >= max) {
      throw planLimit(`You've used all ${max} AI captions for today on the ${PLAN_LABEL[plan]} plan.`, {
        limit: "aiCaptionsPerDay",
        max,
        plan,
      });
    }
  }
  await db.insert(aiUsage).values({ userId, kind });
}
