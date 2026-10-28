import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasDb, resetDb } from "./helpers/db";
import { makeAccount, makeUser } from "./helpers/fixtures";

vi.mock("@/lib/inngest/client", () => ({ inngest: { send: vi.fn(), createFunction: vi.fn() } }));
const deleteRemote = vi.fn();
const fetchCollaborators = vi.fn();
const twitterDelete = vi.fn();
vi.mock("@/lib/platforms", async (orig) => {
  const real = await orig<typeof import("@/lib/platforms")>();
  return {
    ...real,
    getAdapter: (p: string) =>
      p === "instagram"
        ? { platform: "instagram", implemented: true, publish: vi.fn(), refreshToken: vi.fn(), deletePost: deleteRemote, fetchCollaborators }
        : p === "twitter"
          ? { platform: "twitter", implemented: true, publish: vi.fn(), refreshToken: vi.fn(), deletePost: twitterDelete }
          : real.getAdapter(p as never),
  };
});

import { getDb } from "@/lib/db";
import { comments, postTargets, posts } from "@/lib/db/schema";
import { deletePost, postCollaborators } from "@/lib/posts";
import { PlatformError } from "@/lib/platforms/types";

describe.skipIf(!hasDb)("deleting a published post, and collaborator invites", () => {
  let userId: string;
  let actor: { userId: string; plan: "free" | "premium" };
  let ig: Awaited<ReturnType<typeof makeAccount>>;

  beforeEach(async () => {
    await resetDb();
    deleteRemote.mockReset().mockResolvedValue(undefined);
    fetchCollaborators.mockReset();
    twitterDelete.mockReset();
    userId = (await makeUser("user_d")).id;
    actor = { userId, plan: "free" };
    ig = await makeAccount(userId, "instagram", "asha.makes");
  });
  afterAll(resetDb);

  /** A published post with one published target per given account. */
  async function published(targets: { accountId: string; platform: string; mediaId: string; collaborators?: string[]; status?: string }[]) {
    const [post] = await getDb().insert(posts).values({ userId, content: "Launch", status: "published", publishedAt: new Date() }).returning();
    const rows = [];
    for (const t of targets) {
      const [row] = await getDb()
        .insert(postTargets)
        .values({ postId: post.id, socialAccountId: t.accountId, platform: t.platform, status: t.status ?? "published", platformPostId: t.mediaId, collaborators: t.collaborators ?? [] })
        .returning();
      rows.push(row);
    }
    return { post, targets: rows };
  }
  const exists = async (id: string) => (await getDb().select().from(posts).where(eq(posts.id, id))).length === 1;

  it("by default only removes it from Social Copilot", async () => {
    const { post } = await published([{ accountId: ig.id, platform: "instagram", mediaId: "M1" }]);
    await deletePost(actor, post.id);
    expect(deleteRemote).not.toHaveBeenCalled();
    expect(await exists(post.id)).toBe(false);
  });

  it("with fromPlatforms, deletes it on Instagram first, then here, along with its synced comments", async () => {
    const { post } = await published([{ accountId: ig.id, platform: "instagram", mediaId: "M1" }]);
    await getDb()
      .insert(comments)
      .values([
        { userId, socialAccountId: ig.id, platform: "instagram", platformCommentId: "c1", platformPostId: "M1", text: "nice", commentedAt: new Date() },
        { userId, socialAccountId: ig.id, platform: "instagram", platformCommentId: "c2", platformPostId: "OTHER", text: "keep", commentedAt: new Date() },
      ]);
    await deletePost(actor, post.id, { fromPlatforms: true });
    expect(deleteRemote).toHaveBeenCalledTimes(1);
    expect(deleteRemote.mock.calls[0][0]).toMatchObject({ id: ig.id });
    expect(deleteRemote.mock.calls[0][1]).toBe("M1");
    expect(await exists(post.id)).toBe(false);
    expect((await getDb().select().from(comments)).map((c) => c.platformCommentId)).toEqual(["c2"]);
  });

  it("if Instagram refuses, nothing is deleted here and the reason is shown", async () => {
    const { post } = await published([{ accountId: ig.id, platform: "instagram", mediaId: "M1" }]);
    deleteRemote.mockRejectedValue(new PlatformError("Deleting the post on Instagram: (#10) Application does not have permission for this action", "api", false));
    await expect(deletePost(actor, post.id, { fromPlatforms: true })).rejects.toMatchObject({
      code: "PLATFORM_DELETE_FAILED",
      message: expect.stringMatching(/@asha\.makes on Instagram: Deleting the post on Instagram: \(#10\).*Nothing was deleted in Social Copilot/),
    });
    expect(await exists(post.id)).toBe(true);
  });

  it("two Instagram accounts, one refuses: the deleted one is not asked again on retry", async () => {
    const shop = await makeAccount(userId, "instagram", "asha.shop");
    const { post, targets } = await published([
      { accountId: ig.id, platform: "instagram", mediaId: "M1" },
      { accountId: shop.id, platform: "instagram", mediaId: "M2" },
    ]);
    deleteRemote.mockImplementation(async (_a: unknown, id: string) => {
      if (id === "M2") throw new PlatformError("rate limited", "rate_limit", true);
    });
    await expect(deletePost(actor, post.id, { fromPlatforms: true })).rejects.toMatchObject({ code: "PLATFORM_DELETE_FAILED" });
    const first = (await getDb().select().from(postTargets).where(eq(postTargets.id, targets[0].id)))[0];
    expect(first).toMatchObject({ platformPostId: null, platformPostUrl: null });

    deleteRemote.mockReset().mockResolvedValue(undefined);
    await deletePost(actor, post.id, { fromPlatforms: true });
    expect(deleteRemote.mock.calls.map((c) => c[1])).toEqual(["M2"]);
    expect(await exists(post.id)).toBe(false);
  });

  it("only platforms that allow it are asked; other copies stay where they are", async () => {
    const x = await makeAccount(userId, "twitter", "asha_x");
    const { post } = await published([
      { accountId: ig.id, platform: "instagram", mediaId: "M1" },
      { accountId: x.id, platform: "twitter", mediaId: "T1" },
      { accountId: (await makeAccount(userId, "instagram", "failed_ig")).id, platform: "instagram", mediaId: "M9", status: "failed" },
    ]);
    await deletePost(actor, post.id, { fromPlatforms: true });
    expect(deleteRemote.mock.calls.map((c) => c[1])).toEqual(["M1"]); // not the failed target
    expect(twitterDelete).not.toHaveBeenCalled(); // X is not marked deletesPosts
  });

  describe("collaborator invites", () => {
    it("matches each requested username to Instagram's invite; a missing one is 'not_invited'", async () => {
      const { post, targets } = await published([{ accountId: ig.id, platform: "instagram", mediaId: "M1", collaborators: ["ben_k", "cara.co"] }]);
      fetchCollaborators.mockResolvedValue([{ username: "ben_k", status: "pending" }]);
      expect(await postCollaborators(userId, post.id)).toEqual([
        { targetId: targets[0].id, error: null, collaborators: [{ username: "ben_k", status: "pending" }, { username: "cara.co", status: "not_invited" }] },
      ]);
      expect(fetchCollaborators.mock.calls[0][1]).toBe("M1");
    });

    it("not asked before publishing; a failed read shows the reason; targets without collaborators are left out", async () => {
      const { post, targets } = await published([
        { accountId: ig.id, platform: "instagram", mediaId: "M1", collaborators: ["ben_k"] },
        { accountId: (await makeAccount(userId, "instagram", "second")).id, platform: "instagram", mediaId: "M2", collaborators: ["dev"], status: "pending" },
      ]);
      await getDb().insert(postTargets).values({ postId: post.id, socialAccountId: (await makeAccount(userId, "instagram", "plain")).id, platform: "instagram" });
      fetchCollaborators.mockRejectedValue(new PlatformError("Reading the post's collaborators: (#10) Permission denied", "api", false));
      const out = await postCollaborators(userId, post.id);
      expect(out).toHaveLength(2);
      expect(out.find((t) => t.targetId === targets[0].id)).toMatchObject({ collaborators: [{ username: "ben_k", status: "unknown" }], error: expect.stringContaining("Permission denied") });
      expect(out.find((t) => t.targetId === targets[1].id)).toMatchObject({ collaborators: [{ username: "dev", status: "not_published" }], error: null });
      expect(fetchCollaborators).toHaveBeenCalledTimes(1);
    });

    it("is scoped to the post's owner", async () => {
      const { post } = await published([{ accountId: ig.id, platform: "instagram", mediaId: "M1", collaborators: ["ben_k"] }]);
      const other = (await makeUser("user_x")).id;
      await expect(postCollaborators(other, post.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(deletePost({ userId: other, plan: "free" }, post.id, { fromPlatforms: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(deleteRemote).not.toHaveBeenCalled();
    });
  });
});
