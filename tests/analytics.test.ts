import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasDb, resetDb } from "./helpers/db";
import { makeAccount, makeUser } from "./helpers/fixtures";

const fetchMetrics = vi.fn();
vi.mock("@/lib/platforms", async (orig) => {
  const real = await orig<typeof import("@/lib/platforms")>();
  return {
    ...real,
    getAdapter: (p: string) => {
      const a = real.getAdapter(p as never);
      return p === "twitter" ? { ...a, fetchMetrics: (...args: unknown[]) => fetchMetrics(...args) } : a;
    },
  };
});

import { getAnalytics } from "@/lib/analytics";
import { getDb } from "@/lib/db";
import { postMetrics, postTargets, posts } from "@/lib/db/schema";
import { syncMetrics } from "@/lib/metrics";
import { PlatformError } from "@/lib/platforms/types";

const NOW = new Date("2026-10-27T10:00:00Z");
const day = 86_400_000;
const at = (offsetDays: number, hourUtc = 10) => new Date(Date.UTC(2026, 9, 27 + offsetDays, hourUtc));

describe.skipIf(!hasDb)("analytics", () => {
  let userId: string;
  let x: Awaited<ReturnType<typeof makeAccount>>;
  let yt: Awaited<ReturnType<typeof makeAccount>>;

  async function seed(opts: { status: string; when: Date; content?: string; targets?: { account: typeof x; status?: string; platformPostId?: string }[]; user?: string }) {
    const db = getDb();
    const [p] = await db
      .insert(posts)
      .values({
        userId: opts.user ?? userId,
        content: opts.content ?? "post",
        status: opts.status,
        scheduledAt: opts.status === "published" ? null : opts.when,
        publishedAt: opts.status === "published" ? opts.when : null,
        queuedAt: opts.status === "draft" ? null : opts.when,
        createdAt: opts.when,
      })
      .returning();
    const ts = [];
    for (const t of opts.targets ?? [{ account: x }]) {
      const [row] = await db
        .insert(postTargets)
        .values({
          postId: p.id,
          socialAccountId: t.account.id,
          platform: t.account.platform,
          status: t.status ?? (opts.status === "published" ? "published" : opts.status === "failed" ? "failed" : "pending"),
          platformPostId: t.platformPostId,
          publishedAt: opts.status === "published" ? opts.when : null,
        })
        .returning();
      ts.push(row);
    }
    return { post: p, targets: ts };
  }

  beforeEach(async () => {
    await resetDb();
    fetchMetrics.mockReset();
    userId = (await makeUser("user_an")).id;
    x = await makeAccount(userId, "twitter", "ex");
    yt = await makeAccount(userId, "youtube", "why");
  });
  afterAll(resetDb);

  it("counts by status, ignores drafts, and respects the range", async () => {
    await seed({ status: "published", when: at(-1) });
    await seed({ status: "published", when: at(-2) });
    await seed({ status: "published", when: at(-40) }); // outside 30d, inside 90d
    await seed({ status: "scheduled", when: at(3) });
    await seed({ status: "failed", when: at(-3) });
    await seed({ status: "draft", when: at(-1) });

    const a30 = await getAnalytics(userId, "UTC", 30, NOW);
    expect(a30.totals).toEqual({ total: 4, published: 2, scheduled: 1, failed: 1, publishing: 0 });
    const a90 = await getAnalytics(userId, "UTC", 90, NOW);
    expect(a90.totals.published).toBe(3);
    const a7 = await getAnalytics(userId, "UTC", 7, NOW);
    expect(a7.totals.total).toBe(4);
  });

  it("returns a dense daily series (zeros, not gaps) that includes the look-ahead week", async () => {
    await seed({ status: "published", when: at(-1) });
    await seed({ status: "scheduled", when: at(3) });
    const a = await getAnalytics(userId, "UTC", 7, NOW);
    expect(a.daily).toHaveLength(7 + 7);
    expect(a.daily[0].date).toBe("2026-10-21");
    expect(a.daily.at(-1)!.date).toBe("2026-11-03");
    const find = (d: string) => a.daily.find((p) => p.date === d)!;
    expect(find("2026-10-26")).toEqual({ date: "2026-10-26", published: 1, scheduled: 0, failed: 0 });
    expect(find("2026-10-30")).toEqual({ date: "2026-10-30", published: 0, scheduled: 1, failed: 0 });
    expect(find("2026-10-25")).toEqual({ date: "2026-10-25", published: 0, scheduled: 0, failed: 0 });
  });

  it("buckets days in the user's timezone (20:00Z is already tomorrow in IST)", async () => {
    await seed({ status: "published", when: at(-1, 20) }); // 2026-10-26T20:00Z = 2026-10-27 01:30 IST
    const utc = await getAnalytics(userId, "UTC", 7, NOW);
    const ist = await getAnalytics(userId, "Asia/Kolkata", 7, NOW);
    expect(utc.daily.find((p) => p.date === "2026-10-26")!.published).toBe(1);
    expect(ist.daily.find((p) => p.date === "2026-10-27")!.published).toBe(1);
    expect(ist.daily.find((p) => p.date === "2026-10-26")!.published).toBe(0);
  });

  it("splits by platform, counting one post to two platforms once for each", async () => {
    await seed({ status: "published", when: at(-1), targets: [{ account: x }, { account: yt }] });
    await seed({ status: "published", when: at(-2), targets: [{ account: x }] });
    await seed({ status: "failed", when: at(-3), targets: [{ account: x }] });
    const a = await getAnalytics(userId, "UTC", 30, NOW);
    expect(a.platforms).toEqual([
      { platform: "twitter", total: 3, published: 2, scheduled: 0, failed: 1 },
      { platform: "youtube", total: 1, published: 1, scheduled: 0, failed: 0 },
    ]);
    expect(a.totals.total).toBe(3); // posts, not targets
  });

  it("lists what already happened (newest first) separately from what is coming (soonest first)", async () => {
    await seed({ status: "published", when: at(-5), content: "older" });
    await seed({ status: "published", when: at(-1), content: "newer" });
    await seed({ status: "failed", when: at(-3), content: "broke" });
    await seed({ status: "draft", when: at(0), content: "draft" });
    await seed({ status: "scheduled", when: at(5), content: "later" });
    await seed({ status: "scheduled", when: at(2), content: "sooner" });
    const a = await getAnalytics(userId, "UTC", 30, NOW);
    expect(a.recent.map((p) => p.content)).toEqual(["newer", "broke", "older"]); // no drafts, no scheduled
    expect(a.upcoming.map((p) => p.content)).toEqual(["sooner", "later"]);
    expect(a.recent[0].targets[0].platform).toBe("twitter");
  });

  it("shows upcoming posts even when they fall outside the selected range", async () => {
    await seed({ status: "scheduled", when: at(60), content: "far away" });
    expect((await getAnalytics(userId, "UTC", 7, NOW)).upcoming.map((p) => p.content)).toEqual(["far away"]);
  });

  it("never mixes users", async () => {
    const other = await makeUser("user_other");
    const ox = await makeAccount(other.id, "twitter", "theirs");
    await seed({ status: "published", when: at(-1), user: other.id, targets: [{ account: ox }] });
    const mine = await getAnalytics(userId, "UTC", 30, NOW);
    expect(mine.totals.total).toBe(0);
    expect(mine.recent).toEqual([]);
    expect(mine.upcoming).toEqual([]);
    expect(mine.platforms).toEqual([]);
  });

  it("is empty-safe", async () => {
    const a = await getAnalytics(userId, "UTC", 30, NOW);
    expect(a.totals).toEqual({ total: 0, published: 0, scheduled: 0, failed: 0, publishing: 0 });
    expect(a.engagement).toMatchObject({ available: false, likes: 0, top: [] });
  });

  describe("engagement", () => {
    it("is 'not available' until a platform reports numbers (no fake zeros)", async () => {
      await seed({ status: "published", when: at(-1), targets: [{ account: x, platformPostId: "t1" }] });
      expect((await getAnalytics(userId, "UTC", 30, NOW)).engagement.available).toBe(false);
    });

    it("sums reported metrics and ranks the top posts", async () => {
      const a = await seed({ status: "published", when: at(-1), content: "quiet", targets: [{ account: x, platformPostId: "t1" }] });
      const b = await seed({ status: "published", when: at(-2), content: "popular", targets: [{ account: x, platformPostId: "t2" }] });
      await getDb().insert(postMetrics).values([
        { postTargetId: a.targets[0].id, likes: 2, comments: 1, impressions: 100 },
        { postTargetId: b.targets[0].id, likes: 40, comments: 5, impressions: 900 },
      ]);
      const e = (await getAnalytics(userId, "UTC", 30, NOW)).engagement;
      expect(e).toMatchObject({ available: true, likes: 42, comments: 6, impressions: 1000 });
      expect(e.top.map((t) => t.content)).toEqual(["popular", "quiet"]);
      expect(e.updatedAt).not.toBeNull();
    });
  });

  describe("metrics sync", () => {
    it("fetches per account, stores the numbers, and updates them on the next sync", async () => {
      const a = await seed({ status: "published", when: new Date(NOW.getTime() - day), targets: [{ account: x, platformPostId: "t1" }] });
      fetchMetrics.mockResolvedValue(new Map([["t1", { likes: 5, comments: 2, impressions: 80 }]]));
      expect(await syncMetrics({ now: NOW })).toMatchObject({ accounts: 1, updated: 1, skipped: [] });
      expect(fetchMetrics.mock.calls[0][1]).toEqual(["t1"]);

      fetchMetrics.mockResolvedValue(new Map([["t1", { likes: 9, comments: 2, impressions: 120 }]]));
      await syncMetrics({ now: NOW });
      const rows = await getDb().select().from(postMetrics);
      expect(rows).toHaveLength(1); // upsert, not a new row
      expect(rows[0]).toMatchObject({ postTargetId: a.targets[0].id, likes: 9, impressions: 120 });
    });

    it("one account failing (e.g. no read access on its plan) does not stop the others and stores nothing for it", async () => {
      const ex2 = await makeAccount(userId, "twitter", "ex2");
      await seed({ status: "published", when: new Date(NOW.getTime() - day), targets: [{ account: x, platformPostId: "a1" }] });
      const ok = await seed({ status: "published", when: new Date(NOW.getTime() - day), targets: [{ account: ex2, platformPostId: "b1" }] });
      fetchMetrics.mockImplementation(async (acct: { username: string }) => {
        if (acct.username === "ex") throw new PlatformError("Reading X post metrics: your plan has no read access", "api", false, 403);
        return new Map([["b1", { likes: 1, comments: 0, impressions: 10 }]]);
      });
      const r = await syncMetrics({ now: NOW });
      expect(r.updated).toBe(1);
      expect(r.skipped).toEqual([{ accountId: x.id, reason: expect.stringContaining("no read access") }]);
      const rows = await getDb().select().from(postMetrics);
      expect(rows.map((m) => m.postTargetId)).toEqual([ok.targets[0].id]);
    });

    it("never stores a row of nulls", async () => {
      await seed({ status: "published", when: new Date(NOW.getTime() - day), targets: [{ account: x, platformPostId: "t1" }] });
      fetchMetrics.mockResolvedValue(new Map([["t1", { likes: null, comments: null, impressions: null }]]));
      expect((await syncMetrics({ now: NOW })).updated).toBe(0);
      expect(await getDb().select().from(postMetrics)).toHaveLength(0);
    });

    it("skips platforms without metrics support and old posts", async () => {
      await seed({ status: "published", when: new Date(NOW.getTime() - day), targets: [{ account: yt, platformPostId: "v1" }] });
      await seed({ status: "published", when: new Date(NOW.getTime() - 60 * day), targets: [{ account: x, platformPostId: "old" }] });
      const r = await syncMetrics({ now: NOW });
      expect(fetchMetrics).not.toHaveBeenCalled();
      expect(r.accounts).toBe(1); // only the recent YouTube post is in range
    });
  });
});
