import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasDb, resetDb } from "./helpers/db";
import { makeAccount, makeMedia, makeUser } from "./helpers/fixtures";

const publish = vi.fn();
vi.mock("@/lib/platforms", async (orig) => {
  const real = await orig<typeof import("@/lib/platforms")>();
  return {
    ...real,
    getAdapter: (p: string) => (p === "twitter" ? { platform: "twitter", implemented: true, publish, refreshToken: vi.fn() } : real.getAdapter(p as never)),
  };
});

import { getDb } from "@/lib/db";
import { mediaAssets, postTargets, posts, socialAccounts } from "@/lib/db/schema";
import { beginPublish, failPost, finalizePost, publishTarget } from "@/lib/publisher";
import { PlatformError } from "@/lib/platforms/types";

describe.skipIf(!hasDb)("publisher", () => {
  let userId: string;
  let accounts: Awaited<ReturnType<typeof makeAccount>>[];

  /** A scheduled post with one target per account, already carrying a schedule token. */
  async function seedPost(token = "tok-1", content = "Hello from the tests") {
    const [post] = await getDb()
      .insert(posts)
      .values({ userId, content, status: "scheduled", scheduledAt: new Date(), queuedAt: new Date(), inngestEventId: token })
      .returning();
    const targets = [];
    for (const a of accounts) {
      const [t] = await getDb().insert(postTargets).values({ postId: post.id, socialAccountId: a.id, platform: "twitter" }).returning();
      targets.push(t);
    }
    return { post, targets };
  }

  beforeEach(async () => {
    await resetDb();
    publish.mockReset();
    userId = (await makeUser("user_p")).id;
    accounts = [await makeAccount(userId, "twitter", "one"), await makeAccount(userId, "twitter", "two")];
  });
  afterAll(resetDb);

  describe("beginPublish (stale-run protection)", () => {
    it("claims a scheduled post whose token matches and lists its targets", async () => {
      const { post, targets } = await seedPost("tok-1");
      const r = await beginPublish(post.id, "tok-1");
      expect(r.proceed).toBe(true);
      expect(r.targetIds.sort()).toEqual(targets.map((t) => t.id).sort());
      expect((await getDb().select().from(posts).where(eq(posts.id, post.id)))[0].status).toBe("publishing");
    });
    it("ignores a run for an old token (the post was rescheduled)", async () => {
      const { post } = await seedPost("tok-new");
      expect((await beginPublish(post.id, "tok-old")).proceed).toBe(false);
      expect((await getDb().select().from(posts))[0].status).toBe("scheduled");
    });
    it("ignores posts that are drafts, published, failed or deleted", async () => {
      const { post } = await seedPost("tok-1");
      for (const status of ["draft", "published", "failed"]) {
        await getDb().update(posts).set({ status }).where(eq(posts.id, post.id));
        expect((await beginPublish(post.id, "tok-1")).proceed).toBe(false);
      }
      expect((await beginPublish("00000000-0000-4000-8000-000000000000", "tok-1")).proceed).toBe(false);
    });
    it("a replayed run can resume a post already marked publishing", async () => {
      const { post } = await seedPost("tok-1");
      await beginPublish(post.id, "tok-1");
      expect((await beginPublish(post.id, "tok-1")).proceed).toBe(true);
    });
    it("skips targets that already published", async () => {
      const { post, targets } = await seedPost("tok-1");
      await getDb().update(postTargets).set({ status: "published" }).where(eq(postTargets.id, targets[0].id));
      const r = await beginPublish(post.id, "tok-1");
      expect(r.targetIds).toEqual([targets[1].id]);
    });
  });

  describe("publishTarget", () => {
    it("publishes, stores the platform id + url, and passes content, account and media in order", async () => {
      const { post, targets } = await seedPost("t", "the caption");
      const m1 = await makeMedia(userId);
      const m2 = await makeMedia(userId);
      await getDb().update(mediaAssets).set({ postId: post.id, position: 1 }).where(eq(mediaAssets.id, m1.id));
      await getDb().update(mediaAssets).set({ postId: post.id, position: 0 }).where(eq(mediaAssets.id, m2.id));
      publish.mockResolvedValue({ platformPostId: "9001", url: "https://x.com/one/status/9001" });

      expect(await publishTarget(targets[0].id)).toEqual({ status: "published" });
      const call = publish.mock.calls[0][0];
      expect(call.content).toBe("the caption");
      expect(call.account).toMatchObject({ username: "one", accessToken: "tok-one" }); // decrypted for the adapter
      expect(call.media.map((m: { url: string }) => m.url)).toEqual([m2.url, m1.url]);

      const [t] = await getDb().select().from(postTargets).where(eq(postTargets.id, targets[0].id));
      expect(t).toMatchObject({ status: "published", platformPostId: "9001", platformPostUrl: "https://x.com/one/status/9001", error: null });
      expect(t.publishedAt).not.toBeNull();
    });

    it("uses the per-account text override when present", async () => {
      const { targets } = await seedPost("t", "default text");
      await getDb().update(postTargets).set({ contentOverride: "tailored for X" }).where(eq(postTargets.id, targets[0].id));
      publish.mockResolvedValue({ platformPostId: "1" });
      await publishTarget(targets[0].id);
      expect(publish.mock.calls[0][0].content).toBe("tailored for X");
    });

    it("passes the target's collaborators to the adapter (none by default)", async () => {
      const { targets } = await seedPost("t");
      await getDb().update(postTargets).set({ collaborators: ["ben_k", "cara.co"] }).where(eq(postTargets.id, targets[0].id));
      publish.mockResolvedValue({ platformPostId: "1" });
      await publishTarget(targets[0].id);
      await publishTarget(targets[1].id);
      expect(publish.mock.calls[0][0].collaborators).toEqual(["ben_k", "cara.co"]);
      expect(publish.mock.calls[1][0].collaborators).toEqual([]);
    });

    it("records a permanent platform error on the target and does not throw", async () => {
      const { targets } = await seedPost();
      publish.mockRejectedValue(new PlatformError("Posting to X: You are not permitted to create a Tweet.", "api", false, 403));
      const r = await publishTarget(targets[0].id);
      expect(r).toEqual({ status: "failed", error: expect.stringContaining("not permitted") });
      expect((await getDb().select().from(postTargets).where(eq(postTargets.id, targets[0].id)))[0]).toMatchObject({ status: "failed", error: expect.stringContaining("not permitted") });
    });

    it("re-throws retryable errors (rate limit / 5xx) so Inngest retries the step", async () => {
      const { targets } = await seedPost();
      publish.mockRejectedValue(new PlatformError("rate limited", "rate_limit", true, 429));
      await expect(publishTarget(targets[0].id)).rejects.toMatchObject({ kind: "rate_limit" });
      // Not failed yet: a retry may still succeed.
      expect((await getDb().select().from(postTargets).where(eq(postTargets.id, targets[0].id)))[0].status).toBe("publishing");
    });

    it("is idempotent: an already-published target is never posted twice (step replay)", async () => {
      const { targets } = await seedPost();
      publish.mockResolvedValue({ platformPostId: "1" });
      await publishTarget(targets[0].id);
      expect(await publishTarget(targets[0].id)).toEqual({ status: "skipped" });
      expect(publish).toHaveBeenCalledTimes(1);
    });

    it("fails (rather than posting) when the account needs reconnecting", async () => {
      const { targets } = await seedPost();
      await getDb().update(socialAccounts).set({ status: "expired" });
      const r = await publishTarget(targets[0].id);
      expect(r.status).toBe("failed");
      expect(r.error).toContain("reconnected");
      expect(publish).not.toHaveBeenCalled();
    });

    it("skips a target whose row vanished", async () => {
      expect(await publishTarget("00000000-0000-4000-8000-000000000000")).toMatchObject({ status: "skipped" });
    });
  });

  describe("resumable progress (publishState)", () => {
    it("saves adapter progress, hands it to the retry, and clears it once published", async () => {
      const { targets } = await seedPost("t");
      publish.mockImplementationOnce(async (input: { saveState: (s: unknown) => Promise<void> }) => {
        await input.saveState({ containerId: "C1" });
        throw new PlatformError("still processing", "api", true);
      });
      await expect(publishTarget(targets[0].id)).rejects.toMatchObject({ retryable: true });
      const read = async () => (await getDb().select().from(postTargets).where(eq(postTargets.id, targets[0].id)))[0];
      expect((await read()).publishState).toEqual({ containerId: "C1" });

      publish.mockResolvedValueOnce({ platformPostId: "M1" });
      await publishTarget(targets[0].id);
      expect(publish.mock.calls[1][0].state).toEqual({ containerId: "C1" });
      expect(await read()).toMatchObject({ status: "published", publishState: null });
    });

    it("a permanent failure drops saved progress so a manual retry starts clean", async () => {
      const { targets } = await seedPost("t");
      publish.mockImplementationOnce(async (input: { saveState: (s: unknown) => Promise<void> }) => {
        await input.saveState({ containerId: "C1" });
        throw new PlatformError("Instagram could not process the media", "validation", false);
      });
      expect(await publishTarget(targets[0].id)).toMatchObject({ status: "failed" });
      expect((await getDb().select().from(postTargets).where(eq(postTargets.id, targets[0].id)))[0].publishState).toBeNull();
    });
  });

  describe("multi-platform outcomes", () => {
    it("all targets published -> post published", async () => {
      const { post, targets } = await seedPost();
      publish.mockResolvedValue({ platformPostId: "1" });
      for (const t of targets) await publishTarget(t.id);
      expect(await finalizePost(post.id)).toBe("published");
      const [p] = await getDb().select().from(posts).where(eq(posts.id, post.id));
      expect(p).toMatchObject({ status: "published", failureReason: null });
      expect(p.publishedAt).not.toBeNull();
    });

    it("one target fails -> the other still publishes, and the post is 'failed' with a per-platform reason", async () => {
      const { post, targets } = await seedPost();
      publish.mockResolvedValueOnce({ platformPostId: "1" }).mockRejectedValueOnce(new PlatformError("Posting to X: duplicate content", "api", false, 403));
      const outcomes = [];
      for (const t of targets) outcomes.push((await publishTarget(t.id)).status);
      expect(outcomes).toEqual(["published", "failed"]);
      expect(await finalizePost(post.id)).toBe("failed");
      const [p] = await getDb().select().from(posts).where(eq(posts.id, post.id));
      expect(p.status).toBe("failed");
      expect(p.failureReason).toContain("duplicate content");
      expect(p.failureReason).toContain("X (Twitter)");
    });

    it("a post with no targets is failed, not silently 'published'", async () => {
      const [post] = await getDb().insert(posts).values({ userId, content: "x", status: "publishing", inngestEventId: "t" }).returning();
      expect(await finalizePost(post.id)).toBe("failed");
    });
  });

  describe("failPost (retries exhausted)", () => {
    it("marks unfinished targets failed, keeps published ones, and fails the post", async () => {
      const { post, targets } = await seedPost("tok-1");
      await beginPublish(post.id, "tok-1");
      await getDb().update(postTargets).set({ status: "published" }).where(eq(postTargets.id, targets[0].id));
      await failPost(post.id, "tok-1", "Publishing failed after several attempts: X is down");
      const rows = await getDb().select().from(postTargets).where(eq(postTargets.postId, post.id));
      expect(rows.find((r) => r.id === targets[0].id)?.status).toBe("published");
      expect(rows.find((r) => r.id === targets[1].id)).toMatchObject({ status: "failed", error: expect.stringContaining("X is down") });
      expect((await getDb().select().from(posts).where(eq(posts.id, post.id)))[0].status).toBe("failed");
    });
    it("does nothing for a stale token (the post was rescheduled meanwhile)", async () => {
      const { post } = await seedPost("tok-new");
      await getDb().update(posts).set({ status: "publishing" }).where(eq(posts.id, post.id));
      await failPost(post.id, "tok-old", "boom");
      expect((await getDb().select().from(posts).where(eq(posts.id, post.id)))[0].status).toBe("publishing");
    });
  });
});
