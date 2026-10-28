import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { getUsableAccount } from "@/lib/accounts";
import type { Platform } from "@/lib/constants";
import { ConfigError } from "@/lib/errors";
import { getDb } from "@/lib/db";
import { mediaAssets, postTargets, posts } from "@/lib/db/schema";
import { getAdapter } from "@/lib/platforms";
import { PLATFORM_META } from "@/lib/platforms/meta";
import { PlatformError, type PublishMedia } from "@/lib/platforms/types";

/**
 * Publishing core. Deliberately independent of Inngest so it can be tested
 * against a real database with a fake adapter. The Inngest function in
 * lib/inngest/functions.ts only sequences these calls.
 */

export type TargetOutcome = { status: "published" | "failed" | "skipped"; error?: string };

/**
 * Atomically move a post to "publishing" iff it is still the schedule this run was
 * created for. Returns false for stale runs (rescheduled, cancelled, deleted,
 * already published), which then do nothing.
 */
export async function beginPublish(postId: string, token: string): Promise<{ proceed: boolean; reason?: string; targetIds: string[] }> {
  const db = getDb();
  const claimed = await db
    .update(posts)
    .set({ status: "publishing", failureReason: null, updatedAt: new Date() })
    .where(and(eq(posts.id, postId), eq(posts.inngestEventId, token), inArray(posts.status, ["scheduled", "publishing"])))
    .returning({ id: posts.id });
  if (claimed.length === 0) return { proceed: false, reason: "stale run (rescheduled, cancelled or already handled)", targetIds: [] };

  const targets = await db
    .select({ id: postTargets.id })
    .from(postTargets)
    .where(and(eq(postTargets.postId, postId), ne(postTargets.status, "published")))
    .orderBy(asc(postTargets.createdAt));
  return { proceed: true, targetIds: targets.map((t) => t.id) };
}

function toPublishMedia(rows: (typeof mediaAssets.$inferSelect)[]): PublishMedia[] {
  return rows.map((m) => ({ url: m.url, type: m.type === "video" ? "video" : "image", sizeBytes: m.sizeBytes }));
}

/**
 * Publish one target. Non-retryable failures are recorded on the target and
 * returned; retryable ones (rate limit, 5xx, network) are re-thrown so Inngest
 * retries this step with backoff. Already-published targets are skipped, which
 * makes a retried run safe.
 */
export async function publishTarget(targetId: string): Promise<TargetOutcome> {
  const db = getDb();
  const [target] = await db.select().from(postTargets).where(eq(postTargets.id, targetId)).limit(1);
  if (!target) return { status: "skipped", error: "target no longer exists" };
  if (target.status === "published") return { status: "skipped" };

  const [post] = await db.select().from(posts).where(eq(posts.id, target.postId)).limit(1);
  if (!post) return { status: "skipped", error: "post no longer exists" };

  await db.update(postTargets).set({ status: "publishing", error: null, updatedAt: new Date() }).where(eq(postTargets.id, targetId));

  // A permanent failure also drops saved progress: a manual retry must start clean, not resume a rejected upload.
  const fail = async (message: string): Promise<TargetOutcome> => {
    await db
      .update(postTargets)
      .set({ status: "failed", error: message.slice(0, 1000), publishState: null, updatedAt: new Date() })
      .where(eq(postTargets.id, targetId));
    return { status: "failed", error: message };
  };

  try {
    if (!PLATFORM_META[target.platform as Platform]?.implemented) {
      return await fail(`${PLATFORM_META[target.platform as Platform]?.name ?? target.platform} is not available yet.`);
    }
    const media = await db.select().from(mediaAssets).where(eq(mediaAssets.postId, post.id)).orderBy(asc(mediaAssets.position));
    const account = await getUsableAccount(target.socialAccountId);
    const result = await getAdapter(target.platform as Platform).publish({
      account,
      content: target.contentOverride ?? post.content,
      media: toPublishMedia(media),
      asVideo: target.postAsVideo,
      collaborators: target.collaborators,
      state: target.publishState,
      saveState: async (state) => {
        await db.update(postTargets).set({ publishState: state, updatedAt: new Date() }).where(eq(postTargets.id, targetId));
      },
    });
    await db
      .update(postTargets)
      .set({
        status: "published",
        platformPostId: result.platformPostId,
        platformPostUrl: result.url ?? null,
        publishedAt: new Date(),
        error: null,
        publishState: null,
        updatedAt: new Date(),
      })
      .where(eq(postTargets.id, targetId));
    return { status: "published" };
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.retryable) throw e; // Inngest retries; onFailure handles exhaustion
      return fail(e.message);
    }
    if (e instanceof ConfigError) return fail(e.message);
    throw e; // unexpected (e.g. database): retry
  }
}

/** Set the final post status from its targets. Published only if every target succeeded. */
export async function finalizePost(postId: string): Promise<"published" | "failed"> {
  const db = getDb();
  const targets = await db.select().from(postTargets).where(eq(postTargets.postId, postId));
  const failed = targets.filter((t) => t.status !== "published");
  if (targets.length > 0 && failed.length === 0) {
    await db.update(posts).set({ status: "published", publishedAt: new Date(), failureReason: null, updatedAt: new Date() }).where(eq(posts.id, postId));
    return "published";
  }
  const reason =
    targets.length === 0
      ? "This post has no targets."
      : failed.map((t) => `${PLATFORM_META[t.platform as Platform]?.name ?? t.platform}: ${t.error ?? "not published"}`).join(" | ");
  await db.update(posts).set({ status: "failed", failureReason: reason.slice(0, 2000), updatedAt: new Date() }).where(eq(posts.id, postId));
  return "failed";
}

/** Called when a run exhausted its retries: nothing may be left "publishing" forever. */
export async function failPost(postId: string, token: string, reason: string) {
  const db = getDb();
  const [post] = await db.select({ token: posts.inngestEventId, status: posts.status }).from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post || post.token !== token || post.status !== "publishing") return;
  await db
    .update(postTargets)
    .set({ status: "failed", error: sql`coalesce(${postTargets.error}, ${reason.slice(0, 1000)})`, updatedAt: new Date() })
    .where(and(eq(postTargets.postId, postId), ne(postTargets.status, "published")));
  await finalizePost(postId);
}
