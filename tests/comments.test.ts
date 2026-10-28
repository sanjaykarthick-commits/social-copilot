import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformComment } from "@/lib/platforms/types";
import { hasDb, resetDb } from "./helpers/db";
import { makeAccount, makeUser } from "./helpers/fixtures";

const fetchComments = vi.fn();
const replyToComment = vi.fn();
const capabilities = vi.fn(() => ({ metrics: true, comments: true }));
vi.mock("@/lib/platforms", async (orig) => {
  const real = await orig<typeof import("@/lib/platforms")>();
  return {
    ...real,
    getAdapter: (p: string) =>
      p === "youtube" ? { platform: "youtube", implemented: true, publish: vi.fn(), refreshToken: vi.fn(), fetchComments, replyToComment, capabilities } : real.getAdapter(p as never),
  };
});

import { listComments, replyToComment as reply, setCommentStatus, syncAccountComments, syncComments } from "@/lib/comments";
import { getDb } from "@/lib/db";
import { commentReplies, comments, postTargets, posts, socialAccounts } from "@/lib/db/schema";
import { AppError } from "@/lib/errors";
import { PlatformError } from "@/lib/platforms/types";

const NOW = new Date();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const c = (id: string, over: Partial<PlatformComment> = {}): PlatformComment => ({
  platformCommentId: id,
  platformPostId: "vid1",
  postUrl: "https://www.youtube.com/watch?v=vid1",
  postTitle: "Their title",
  postThumbnailUrl: null,
  authorName: "Viewer",
  authorHandle: "viewer",
  authorImageUrl: null,
  text: `text ${id}`,
  likeCount: 0,
  createdAt: daysAgo(1),
  ownerReplied: false,
  ...over,
});

describe.skipIf(!hasDb)("comments inbox", () => {
  let userId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDb();
    fetchComments.mockReset();
    replyToComment.mockReset();
    capabilities.mockReset().mockReturnValue({ metrics: true, comments: true });
    userId = (await makeUser("user_c")).id;
    accountId = (await makeAccount(userId, "youtube", "chan")).id;
  });
  afterAll(resetDb);

  async function publishedPost(platformPostId: string, content: string) {
    const [post] = await getDb().insert(posts).values({ userId, content, status: "published", publishedAt: daysAgo(2) }).returning();
    const [t] = await getDb()
      .insert(postTargets)
      .values({ postId: post.id, socialAccountId: accountId, platform: "youtube", status: "published", platformPostId, publishedAt: daysAgo(2) })
      .returning();
    return t;
  }

  describe("sync", () => {
    it("stores new comments, links them to our post and titles them with our text", async () => {
      const target = await publishedPost("vid1", "Our launch video\nmore details");
      fetchComments.mockResolvedValue([c("a"), c("b", { platformPostId: "other" }), c("r", { ownerReplied: true })]);
      const r = await syncAccountComments(accountId, NOW);
      expect(r).toMatchObject({ fetched: 3, added: 3 });
      expect(fetchComments.mock.calls[0][1].knownPostIds).toEqual(["vid1"]);

      const rows = await getDb().select().from(comments);
      const a = rows.find((x) => x.platformCommentId === "a")!;
      expect(a).toMatchObject({ userId, postTargetId: target.id, postTitle: "Our launch video", status: "open" });
      expect(rows.find((x) => x.platformCommentId === "b")!).toMatchObject({ postTargetId: null, postTitle: "Their title" });
      expect(rows.find((x) => x.platformCommentId === "r")!.status).toBe("replied"); // answered in the YouTube app already
      expect((await getDb().select().from(socialAccounts).where(eq(socialAccounts.id, accountId)))[0].lastCommentSyncAt).not.toBeNull();
    });

    it("re-syncing updates counts but never reopens or un-archives what the user handled", async () => {
      fetchComments.mockResolvedValue([c("a"), c("b"), c("x")]);
      await syncAccountComments(accountId, NOW);
      const byId = async (id: string) => (await getDb().select().from(comments).where(eq(comments.platformCommentId, id)))[0];
      await getDb().update(comments).set({ status: "archived" }).where(eq(comments.platformCommentId, "a"));

      fetchComments.mockResolvedValue([c("a", { likeCount: 9, ownerReplied: true }), c("b", { ownerReplied: true }), c("x", { text: "edited" })]);
      const r = await syncAccountComments(accountId, NOW);
      expect(r.added).toBe(0);
      expect(await byId("a")).toMatchObject({ status: "archived", likeCount: 9 });
      expect((await byId("b")).status).toBe("replied");
      expect(await byId("x")).toMatchObject({ status: "open", text: "edited" });
      expect(await getDb().select().from(comments)).toHaveLength(3);
    });

    it("skips connections without comment access instead of failing", async () => {
      capabilities.mockReturnValue({ metrics: true, comments: false, note: "Reconnect YouTube once" } as never);
      expect(await syncAccountComments(accountId, NOW)).toMatchObject({ added: 0, skipped: "Reconnect YouTube once" });
      expect(fetchComments).not.toHaveBeenCalled();
    });

    it("one failing account never stops the others; 'Sync now' respects a per-account cooldown", async () => {
      const second = (await makeAccount(userId, "youtube", "chan2")).id;
      fetchComments.mockImplementation(async (acc: { id: string }) => {
        if (acc.id === accountId) throw new PlatformError("quota exceeded", "api", false);
        return [c("z")];
      });
      const r = await syncComments({ userId, now: NOW });
      expect(r.failed).toEqual([{ accountId, reason: "quota exceeded" }]);
      expect(r.results.map((x) => x.accountId)).toEqual([second]);

      fetchComments.mockClear();
      const again = await syncComments({ userId, now: new Date(NOW.getTime() + 10_000), respectCooldown: true });
      expect(again.results).toEqual([]); // `second` synced 10s ago
      expect(fetchComments).toHaveBeenCalledTimes(1); // only the failed one (never marked synced) is tried
    });
  });

  describe("reply", () => {
    async function oneComment() {
      fetchComments.mockResolvedValue([c("a")]);
      await syncAccountComments(accountId, NOW);
      return (await getDb().select().from(comments))[0];
    }

    it("sends the reply, records it, and moves the comment to Replied", async () => {
      const row = await oneComment();
      replyToComment.mockResolvedValue({ platformReplyId: "R1" });
      const dto = await reply(userId, row.id, { text: "Thank you!", idempotencyKey: "key-00001" });
      expect(replyToComment.mock.calls[0][1]).toMatchObject({ platformCommentId: "a", platformPostId: "vid1" });
      expect(replyToComment.mock.calls[0][2]).toBe("Thank you!");
      expect(dto.status).toBe("replied");
      expect(dto.replies).toMatchObject([{ text: "Thank you!", status: "sent" }]);
    });

    it("a double click (same idempotency key) replies once", async () => {
      const row = await oneComment();
      replyToComment.mockResolvedValue({ platformReplyId: "R1" });
      await Promise.all([
        reply(userId, row.id, { text: "Hi", idempotencyKey: "same-key-1" }),
        reply(userId, row.id, { text: "Hi", idempotencyKey: "same-key-1" }),
      ]);
      expect(replyToComment).toHaveBeenCalledTimes(1);
      expect(await getDb().select().from(commentReplies)).toHaveLength(1);
    });

    it("a platform failure is recorded on the reply and reported; the comment still needs a reply", async () => {
      const row = await oneComment();
      replyToComment.mockRejectedValue(new PlatformError("Replying on YouTube: comments are disabled", "api", false, 403));
      const err = await reply(userId, row.id, { text: "Hi", idempotencyKey: "key-00002" }).catch((e) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({ code: "REPLY_FAILED", status: 502, message: expect.stringContaining("comments are disabled") });
      const [saved] = await getDb().select().from(commentReplies);
      expect(saved).toMatchObject({ status: "failed", error: expect.stringContaining("disabled") });
      expect((await getDb().select().from(comments))[0].status).toBe("open");
    });

    it("checks the platform's reply length and ownership before calling the platform", async () => {
      const row = await oneComment();
      await expect(reply(userId, row.id, { text: "x".repeat(10_001), idempotencyKey: "key-00003" })).rejects.toMatchObject({ code: "VALIDATION" });
      const other = (await makeUser("user_other")).id;
      await expect(reply(other, row.id, { text: "hi", idempotencyKey: "key-00004" })).rejects.toMatchObject({ status: 404 });
      await expect(reply(userId, "not-a-uuid", { text: "hi", idempotencyKey: "key-00005" })).rejects.toMatchObject({ status: 404 });
      expect(replyToComment).not.toHaveBeenCalled();
    });
  });

  describe("list and archive", () => {
    it("filters by status, counts each tab, and only shows the user's own comments", async () => {
      fetchComments.mockResolvedValue([c("a", { createdAt: daysAgo(3) }), c("b", { createdAt: daysAgo(1) }), c("r", { ownerReplied: true })]);
      await syncAccountComments(accountId, NOW);
      const open = await listComments(userId, { status: "open", page: 1, pageSize: 25 });
      expect(open.comments.map((x) => x.text)).toEqual(["text b", "text a"]); // newest first
      expect(open.counts).toEqual({ open: 2, replied: 1, archived: 0 });
      expect(open.comments[0].account.label).toBe("@chan");

      const other = (await makeUser("user_o2")).id;
      expect((await listComments(other, { status: "all", page: 1, pageSize: 25 })).total).toBe(0);
    });

    it("archives, and reopening a replied comment puts it back under Replied", async () => {
      fetchComments.mockResolvedValue([c("a")]);
      await syncAccountComments(accountId, NOW);
      const [row] = await getDb().select().from(comments);
      expect((await setCommentStatus(userId, row.id, "archived")).status).toBe("archived");
      expect((await setCommentStatus(userId, row.id, "open")).status).toBe("open");

      replyToComment.mockResolvedValue({ platformReplyId: "R" });
      await reply(userId, row.id, { text: "hi", idempotencyKey: "key-00009" });
      await setCommentStatus(userId, row.id, "archived");
      expect((await setCommentStatus(userId, row.id, "open")).status).toBe("replied");
    });
  });
});
