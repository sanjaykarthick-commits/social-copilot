import { randomUUID } from "node:crypto";
import { saveConnectedAccount } from "@/lib/accounts";
import type { Platform } from "@/lib/constants";
import { getDb } from "@/lib/db";
import { mediaAssets, subscriptions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { upsertUser } from "@/lib/users";

export async function makeUser(clerkId = `user_${randomUUID().slice(0, 8)}`, plan: "free" | "premium" = "free") {
  const user = await upsertUser(clerkId, { email: `${clerkId}@example.com`, name: clerkId });
  if (plan === "premium") await getDb().update(subscriptions).set({ plan: "premium", status: "active" }).where(eq(subscriptions.userId, user.id));
  return user;
}

export async function makeAccount(userId: string, platform: Platform = "twitter", username = `acct_${randomUUID().slice(0, 6)}`) {
  return saveConnectedAccount(userId, platform, {
    accessToken: "tok-" + username,
    refreshToken: "ref-" + username,
    expiresAt: new Date(Date.now() + 3600_000),
    scopes: "tweet.write",
    platformAccountId: "pid-" + username,
    username,
    displayName: username.toUpperCase(),
    profileImageUrl: null,
  });
}

export async function makeMedia(userId: string, type: "image" | "video" = "image") {
  const [row] = await getDb()
    .insert(mediaAssets)
    .values({
      userId,
      url: `https://ik.imagekit.io/test/${randomUUID()}.${type === "video" ? "mp4" : "jpg"}`,
      type,
      sizeBytes: 1000,
    })
    .returning();
  return row;
}

export const inMinutes = (m: number, from = new Date()) => new Date(from.getTime() + m * 60_000);
