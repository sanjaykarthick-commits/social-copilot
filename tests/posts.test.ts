import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasDb, resetDb } from "./helpers/db";
import { inMinutes, makeAccount, makeMedia, makeUser } from "./helpers/fixtures";

// Replace only the network edge to Inngest; everything else is the real code + real Postgres.
const send = vi.fn();
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: (...a: unknown[]) => send(...a), createFunction: vi.fn() } }));

import { getDb } from "@/lib/db";
import { mediaAssets, postTargets, posts, socialAccounts } from "@/lib/db/schema";
import { createPost, deletePost, publishPostNow, replacePost, reschedulePost } from "@/lib/posts";
import { getPostDTO, listPosts } from "@/lib/posts-query";
import { postBodySchema, type PostBody } from "@/lib/validation/posts";

const body = (over: Partial<PostBody> & Pick<PostBody, "targets">): PostBody => ({
  content: "Hello world",
  mediaIds: [],
  mode: "draft",
  ...over,
});

const names = () => send.mock.calls.map((c) => (c[0] as { name: string }).name);

describe.skipIf(!hasDb)("post scheduling service", () => {
  let user: Awaited<ReturnType<typeof makeUser>>;
  let acct: Awaited<ReturnType<typeof makeAccount>>;
  let actor: { userId: string; plan: "free" | "premium" };

  beforeEach(async () => {
    await resetDb();
    send.mockReset();
    send.mockResolvedValue(undefined);
    user = await makeUser("user_a");
    acct = await makeAccount(user.id, "twitter", "asha");
    actor = { userId: user.id, plan: "free" };
  });
  afterAll(resetDb);

  const target = () => ({ socialAccountId: acct.id, postAsVideo: false });

  describe("create", () => {
    it("saves a draft without touching the scheduler or the monthly quota", async () => {
      const post = await createPost(actor, body({ targets: [target()], mode: "draft" }));
      expect(post).toMatchObject({ status: "draft", queuedAt: null });
      expect(post.targets).toHaveLength(1);
      expect(send).not.toHaveBeenCalled();
    });

    it("allows an empty draft (work in progress)", async () => {
      const post = await createPost(actor, { content: "", targets: [], mediaIds: [], mode: "draft" });
      expect(post.status).toBe("draft");
    });

    it("schedules: stores UTC time, a token, and sends one post/scheduled event", async () => {
      const when = inMinutes(120);
      const post = await createPost(actor, body({ targets: [target()], mode: "schedule", scheduledAt: when.toISOString() }));
      expect(post.status).toBe("scheduled");
      expect(new Date(post.scheduledAt!).getTime()).toBe(when.getTime());
      expect(post.queuedAt).not.toBeNull();

      expect(send).toHaveBeenCalledTimes(1);
      const evt = send.mock.calls[0][0];
      const [row] = await getDb().select().from(posts).where(eq(posts.id, post.id));
      expect(evt).toMatchObject({ name: "post/scheduled", data: { postId: post.id, token: row.inngestEventId, scheduledAt: when.toISOString() } });
      expect(evt.id).toBe(`sched-${row.inngestEventId}`); // event-level idempotency
    });

    it("post now: status publishing and a post/publish.now event (same publisher path)", async () => {
      const post = await createPost(actor, body({ targets: [target()], mode: "now" }));
      expect(post.status).toBe("publishing");
      expect(names()).toEqual(["post/publish.now"]);
    });

    it("saves a draft with a chosen time but does not schedule it", async () => {
      const when = inMinutes(500);
      const post = await createPost(actor, body({ targets: [target()], mode: "draft", scheduledAt: when.toISOString() }));
      expect(post.status).toBe("draft");
      expect(new Date(post.scheduledAt!).getTime()).toBe(when.getTime());
      expect(send).not.toHaveBeenCalled();
    });

    it("when the scheduler is down, nothing is queued and the work is kept as a draft", async () => {
      send.mockRejectedValue(new Error("connect ECONNREFUSED"));
      const err = await createPost(actor, body({ targets: [target()], mode: "schedule", scheduledAt: inMinutes(60).toISOString() })).catch((e) => e);
      expect(err).toMatchObject({ code: "SCHEDULER_UNAVAILABLE", status: 503, details: { savedAsDraft: true } });
      const [row] = await getDb().select().from(posts);
      expect(row).toMatchObject({ status: "draft", queuedAt: null, inngestEventId: null });
      expect(err.details.postId).toBe(row.id);
    });

    it("attaches media in order and ties it to the post", async () => {
      const m1 = await makeMedia(user.id);
      const m2 = await makeMedia(user.id);
      const post = await createPost(actor, body({ targets: [target()], mediaIds: [m2.id, m1.id], mode: "draft" }));
      expect(post.media.map((m) => m.id)).toEqual([m2.id, m1.id]);
    });
  });

  describe("validation", () => {
    const sched = (over: Partial<PostBody> = {}) => body({ targets: [target()], mode: "schedule", scheduledAt: inMinutes(60).toISOString(), ...over });

    it("rejects a time in the past or under a minute away", async () => {
      await expect(createPost(actor, sched({ scheduledAt: inMinutes(-5).toISOString() }))).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(createPost(actor, sched({ scheduledAt: new Date(Date.now() + 20_000).toISOString() }))).rejects.toMatchObject({ code: "VALIDATION" });
    });
    it("rejects a schedule with no time", async () => {
      await expect(createPost(actor, sched({ scheduledAt: undefined }))).rejects.toMatchObject({ code: "VALIDATION" });
    });
    it("rejects scheduling with no accounts", async () => {
      await expect(createPost(actor, sched({ targets: [] }))).rejects.toMatchObject({ code: "VALIDATION" });
    });
    it("rejects text over X's 280 limit but counts a long URL as 23", async () => {
      await expect(createPost(actor, sched({ content: "x".repeat(281) }))).rejects.toMatchObject({ code: "VALIDATION" });
      const ok = await createPost(actor, sched({ content: `${"x".repeat(250)} https://example.com/${"p".repeat(200)}` }));
      expect(ok.status).toBe("scheduled");
    });
    it("rejects an empty post with no media", async () => {
      await expect(createPost(actor, sched({ content: "  " }))).rejects.toMatchObject({ code: "VALIDATION" });
    });
    it("rejects X posts mixing images and video, or more than 4 images", async () => {
      const img = await makeMedia(user.id, "image");
      const vid = await makeMedia(user.id, "video");
      await expect(createPost(actor, sched({ mediaIds: [img.id, vid.id] }))).rejects.toMatchObject({ code: "VALIDATION" });
      const five = await Promise.all([1, 2, 3, 4, 5].map(() => makeMedia(user.id)));
      await expect(createPost(actor, sched({ mediaIds: five.map((m) => m.id) }))).rejects.toMatchObject({ code: "VALIDATION" });
    });
    it("rejects accounts that need reconnecting", async () => {
      await getDb().update(socialAccounts).set({ status: "expired" }).where(eq(socialAccounts.id, acct.id));
      await expect(createPost(actor, sched())).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("reconnected") });
    });
    it("stores Instagram collaborators per target, normalized, and returns them for editing", async () => {
      const ig = await makeAccount(user.id, "instagram", "asha.ig");
      const parsed = postBodySchema.parse({ mode: "draft", content: "x", targets: [{ socialAccountId: ig.id, collaborators: ["@Ben_K", "cara.co"] }, { socialAccountId: acct.id }] });
      const post = await createPost(actor, parsed);
      const byAccount = Object.fromEntries(post.targets.map((t) => [t.socialAccountId, t.collaborators]));
      expect(byAccount).toEqual({ [ig.id]: ["ben_k", "cara.co"], [acct.id]: [] });
    });
    it("rejects collaborators on a non-Instagram target", async () => {
      await expect(createPost(actor, sched({ targets: [{ ...target(), collaborators: ["ben_k"] }] }))).rejects.toMatchObject({
        code: "VALIDATION",
        message: expect.stringContaining("only available on Instagram"),
      });
    });
    it("a per-account text override is validated against that platform", async () => {
      await expect(createPost(actor, sched({ targets: [{ ...target(), contentOverride: "y".repeat(300) }] }))).rejects.toMatchObject({ code: "VALIDATION" });
    });
  });

  describe("ownership", () => {
    it("cannot post to someone else's account", async () => {
      const other = await makeUser("user_b");
      const theirs = await makeAccount(other.id, "twitter", "mallory");
      await expect(createPost(actor, body({ targets: [{ socialAccountId: theirs.id, postAsVideo: false }], mode: "draft" }))).rejects.toMatchObject({ code: "VALIDATION" });
    });
    it("cannot attach someone else's media", async () => {
      const other = await makeUser("user_b");
      const theirs = await makeMedia(other.id);
      await expect(createPost(actor, body({ targets: [target()], mediaIds: [theirs.id], mode: "draft" }))).rejects.toMatchObject({ code: "VALIDATION" });
    });
    it("cannot read, move, publish or delete someone else's post", async () => {
      const post = await createPost(actor, body({ targets: [target()], mode: "schedule", scheduledAt: inMinutes(60).toISOString() }));
      const intruder = { userId: (await makeUser("user_b")).id, plan: "free" as const };
      expect(await getPostDTO(intruder.userId, post.id)).toBeNull();
      await expect(reschedulePost(intruder, post.id, inMinutes(90))).rejects.toMatchObject({ status: 404 });
      await expect(publishPostNow(intruder, post.id)).rejects.toMatchObject({ status: 404 });
      await expect(deletePost(intruder, post.id)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("reschedule (calendar drag and drop)", () => {
    async function scheduled() {
      const post = await createPost(actor, body({ targets: [target()], mode: "schedule", scheduledAt: inMinutes(60).toISOString() }));
      const [row] = await getDb().select().from(posts).where(eq(posts.id, post.id));
      send.mockClear();
      return { post, oldToken: row.inngestEventId! };
    }

    it("sends the NEW schedule first, then cancels only the OLD token", async () => {
      const { post, oldToken } = await scheduled();
      const to = inMinutes(300);
      const moved = await reschedulePost(actor, post.id, to);
      expect(new Date(moved.scheduledAt!).getTime()).toBe(to.getTime());

      expect(names()).toEqual(["post/scheduled", "post/cancelled"]);
      const [newEvt, cancelEvt] = send.mock.calls.map((c) => c[0]);
      expect(newEvt.data.token).not.toBe(oldToken);
      expect(cancelEvt.data).toEqual({ postId: post.id, token: oldToken });
      const [row] = await getDb().select().from(posts).where(eq(posts.id, post.id));
      expect(row.inngestEventId).toBe(newEvt.data.token);
    });

    it("if the scheduler rejects the move, the post keeps its old time and run (never left without one)", async () => {
      const { post, oldToken } = await scheduled();
      const before = (await getDb().select().from(posts).where(eq(posts.id, post.id)))[0];
      send.mockRejectedValueOnce(new Error("down"));
      await expect(reschedulePost(actor, post.id, inMinutes(300))).rejects.toMatchObject({ code: "SCHEDULER_UNAVAILABLE" });
      const [after] = await getDb().select().from(posts).where(eq(posts.id, post.id));
      expect(after.scheduledAt!.getTime()).toBe(before.scheduledAt!.getTime());
      expect(after.inngestEventId).toBe(oldToken);
      expect(names()).toEqual(["post/scheduled"]); // no cancel was sent for the still-live old run
    });

    it("rejects past times and non-scheduled posts", async () => {
      const { post } = await scheduled();
      await expect(reschedulePost(actor, post.id, inMinutes(-10))).rejects.toMatchObject({ code: "VALIDATION" });
      const draft = await createPost(actor, body({ targets: [target()], mode: "draft" }));
      await expect(reschedulePost(actor, draft.id, inMinutes(60))).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("edit", () => {
    it("moving a scheduled post back to draft cancels its run", async () => {
      const post = await createPost(actor, body({ targets: [target()], mode: "schedule", scheduledAt: inMinutes(60).toISOString() }));
      const [row] = await getDb().select().from(posts).where(eq(posts.id, post.id));
      send.mockClear();
      const edited = await replacePost(actor, post.id, body({ content: "New text", targets: [target()], mode: "draft" }));
      expect(edited).toMatchObject({ status: "draft", content: "New text" });
      expect(send.mock.calls.map((c) => c[0])).toEqual([{ name: "post/cancelled", data: { postId: post.id, token: row.inngestEventId } }]);
    });

    it("editing a scheduled post's content and time re-queues it under a new token", async () => {
      const post = await createPost(actor, body({ targets: [target()], mode: "schedule", scheduledAt: inMinutes(60).toISOString() }));
      send.mockClear();
      const edited = await replacePost(actor, post.id, body({ content: "Edited", targets: [target()], mode: "schedule", scheduledAt: inMinutes(180).toISOString() }));
      expect(edited).toMatchObject({ status: "scheduled", content: "Edited" });
      expect(names()).toEqual(["post/scheduled", "post/cancelled"]);
    });

    it("replacing targets and media releases the old media", async () => {
      const m1 = await makeMedia(user.id);
      const m2 = await makeMedia(user.id);
      const post = await createPost(actor, body({ targets: [target()], mediaIds: [m1.id], mode: "draft" }));
      const edited = await replacePost(actor, post.id, body({ targets: [target()], mediaIds: [m2.id], mode: "draft" }));
      expect(edited.media.map((m) => m.id)).toEqual([m2.id]);
      const [released] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, m1.id));
      expect(released.postId).toBeNull();
    });

    it("published and publishing posts cannot be edited", async () => {
      const post = await createPost(actor, body({ targets: [target()], mode: "draft" }));
      await getDb().update(posts).set({ status: "published" }).where(eq(posts.id, post.id));
      await expect(replacePost(actor, post.id, body({ targets: [target()], mode: "draft" }))).rejects.toMatchObject({ status: 409 });
      await getDb().update(posts).set({ status: "publishing" }).where(eq(posts.id, post.id));
      await expect(replacePost(actor, post.id, body({ targets: [target()], mode: "draft" }))).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("publish now / retry", () => {
    it("publishes a scheduled post immediately and cancels the old schedule", async () => {
      const post = await createPost(actor, body({ targets: [target()], mode: "schedule", scheduledAt: inMinutes(600).toISOString() }));
      send.mockClear();
      const out = await publishPostNow(actor, post.id);
      expect(out.status).toBe("publishing");
      expect(names()).toEqual(["post/publish.now", "post/cancelled"]);
    });

    it("publishes a draft", async () => {
      const post = await createPost(actor, body({ targets: [target()], mode: "draft" }));
      expect((await publishPostNow(actor, post.id)).status).toBe("publishing");
      expect(names()).toEqual(["post/publish.now"]);
    });

    it("retrying a failed post re-runs only the targets that failed", async () => {
      const second = await makeAccount(user.id, "twitter", "second");
      const post = await createPost(actor, body({ targets: [target(), { socialAccountId: second.id, postAsVideo: false }], mode: "draft" }));
      const [t1, t2] = await getDb().select().from(postTargets).where(eq(postTargets.postId, post.id)).orderBy(postTargets.createdAt);
      await getDb().update(postTargets).set({ status: "published", platformPostId: "1" }).where(eq(postTargets.id, t1.id));
      await getDb().update(postTargets).set({ status: "failed", error: "boom" }).where(eq(postTargets.id, t2.id));
      await getDb().update(posts).set({ status: "failed", queuedAt: new Date(), failureReason: "x" }).where(eq(posts.id, post.id));

      const out = await publishPostNow(actor, post.id);
      expect(out.status).toBe("publishing");
      const targets = await getDb().select().from(postTargets).where(eq(postTargets.postId, post.id));
      expect(targets.find((t) => t.id === t1.id)?.status).toBe("published");
      expect(targets.find((t) => t.id === t2.id)).toMatchObject({ status: "pending", error: null });
    });

    it("refuses to publish something already publishing or published", async () => {
      const post = await createPost(actor, body({ targets: [target()], mode: "now" }));
      await expect(publishPostNow(actor, post.id)).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("delete", () => {
    it("cancels the scheduled run and removes the post, targets and its media rows", async () => {
      const m = await makeMedia(user.id);
      const post = await createPost(actor, body({ targets: [target()], mediaIds: [m.id], mode: "schedule", scheduledAt: inMinutes(60).toISOString() }));
      send.mockClear();
      await deletePost(actor, post.id);
      expect(names()).toEqual(["post/cancelled"]);
      expect(await getDb().select().from(posts)).toHaveLength(0);
      expect(await getDb().select().from(postTargets)).toHaveLength(0);
      expect(await getDb().select().from(mediaAssets)).toHaveLength(0);
    });
    it("won't delete a post while it is publishing", async () => {
      const post = await createPost(actor, body({ targets: [target()], mode: "now" }));
      await expect(deletePost(actor, post.id)).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("plan limits", () => {
    it("Free allows 10 queued posts a month; drafts don't count; the 11th is a PLAN_LIMIT", async () => {
      for (let i = 0; i < 3; i++) await createPost(actor, body({ targets: [target()], mode: "draft" }));
      for (let i = 0; i < 10; i++) {
        await createPost(actor, body({ content: `post ${i}`, targets: [target()], mode: "schedule", scheduledAt: inMinutes(60 + i).toISOString() }));
      }
      await expect(
        createPost(actor, body({ content: "one too many", targets: [target()], mode: "schedule", scheduledAt: inMinutes(200).toISOString() })),
      ).rejects.toMatchObject({ code: "PLAN_LIMIT", status: 403 });
    });
    it("editing an already-queued post doesn't use extra quota", async () => {
      for (let i = 0; i < 10; i++) {
        await createPost(actor, body({ content: `p${i}`, targets: [target()], mode: "schedule", scheduledAt: inMinutes(60 + i).toISOString() }));
      }
      const [{ id }] = await listPosts(user.id, { page: 1, pageSize: 1, order: "asc" }).then((r) => r.posts);
      await expect(replacePost(actor, id, body({ content: "edited", targets: [target()], mode: "schedule", scheduledAt: inMinutes(999).toISOString() }))).resolves.toBeTruthy();
    });
    it("Premium is unlimited", async () => {
      const prem = { userId: user.id, plan: "premium" as const };
      for (let i = 0; i < 12; i++) {
        await createPost(prem, body({ content: `p${i}`, targets: [target()], mode: "schedule", scheduledAt: inMinutes(60 + i).toISOString() }));
      }
      expect((await listPosts(user.id, { page: 1, pageSize: 50, order: "asc" })).total).toBe(12);
    });
  });

  describe("listing", () => {
    it("filters by status, platform, text and date window, and paginates", async () => {
      const when = inMinutes(60 * 24 * 30); // ~a month out (scheduling is capped at a year)
      const day = 86_400_000;
      await createPost(actor, body({ content: "alpha launch", targets: [target()], mode: "schedule", scheduledAt: when.toISOString() }));
      await createPost(actor, body({ content: "beta notes", targets: [target()], mode: "draft" }));
      await createPost(actor, body({ content: "100% sure_thing", targets: [target()], mode: "draft" }));

      const q = (o: object) => listPosts(user.id, { page: 1, pageSize: 20, order: "desc", ...o });
      expect((await q({ status: "draft" })).total).toBe(2);
      expect((await q({ status: "scheduled,draft" })).total).toBe(3);
      expect((await q({ q: "ALPHA" })).posts.map((p) => p.content)).toEqual(["alpha launch"]);
      expect((await q({ q: "100%" })).total).toBe(1); // LIKE wildcards are escaped
      expect((await q({ q: "sure_thing" })).total).toBe(1);
      expect((await q({ platform: "youtube" })).total).toBe(0);
      expect((await q({ platform: "twitter" })).total).toBe(3);
      expect((await q({ from: new Date(when.getTime() - day).toISOString(), to: new Date(when.getTime() + day).toISOString() })).total).toBe(1);
      expect((await q({ from: new Date(when.getTime() + 5 * day).toISOString(), to: new Date(when.getTime() + 6 * day).toISOString() })).total).toBe(0);
      const page = await q({ pageSize: 2, page: 2 });
      expect(page.posts).toHaveLength(1);
      expect(page.total).toBe(3);
    });
    it("never returns another user's posts", async () => {
      await createPost(actor, body({ targets: [target()], mode: "draft" }));
      const other = await makeUser("user_b");
      expect((await listPosts(other.id, { page: 1, pageSize: 20, order: "desc" })).total).toBe(0);
    });
  });
});
