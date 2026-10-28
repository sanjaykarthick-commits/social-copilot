import { and, asc, count, desc, eq, inArray, max, ne, sql, sum } from "drizzle-orm";
import { addDays, ymdKey, ymdOf } from "@/lib/calendar";
import type { Platform } from "@/lib/constants";
import { getDb } from "@/lib/db";
import { postMetrics, postTargets, posts } from "@/lib/db/schema";
import { hydratePosts, type PostDTO } from "@/lib/posts-query";
import { toInstant } from "@/lib/time";

export const RANGES = [7, 30, 90] as const;
export type RangeDays = (typeof RANGES)[number];

export interface DailyPoint {
  date: string; // YYYY-MM-DD in the user's timezone
  published: number;
  scheduled: number;
  failed: number;
}

export interface PlatformStat {
  platform: Platform;
  total: number;
  published: number;
  scheduled: number;
  failed: number;
}

export interface TopPost {
  targetId: string;
  postId: string;
  platform: Platform;
  content: string;
  url: string | null;
  likes: number;
  comments: number;
  impressions: number;
}

export interface AnalyticsData {
  range: { days: number; from: string; tz: string };
  totals: { total: number; published: number; scheduled: number; failed: number; publishing: number };
  daily: DailyPoint[];
  platforms: PlatformStat[];
  /** What already happened (published, failed, in flight), newest first. */
  recent: PostDTO[];
  /** What is coming (scheduled), soonest first. Not limited to the selected range. */
  upcoming: PostDTO[];
  engagement: {
    /** false until at least one platform has reported numbers. Never filled with zeros. */
    available: boolean;
    likes: number;
    comments: number;
    impressions: number;
    updatedAt: string | null;
    top: TopPost[];
    /** Per platform, only platforms that reported numbers. */
    byPlatform: { platform: Platform; posts: number; likes: number; comments: number; impressions: number; impressionsKnown: boolean }[];
  };
}

/** How long the activity chart looks ahead, so upcoming scheduled posts are visible. */
const LOOKAHEAD_DAYS = 7;

/**
 * Everything is measured by "activity time": when a post went out, or is due, or (for a
 * failure that never got a time) when it was created. Drafts are excluded; they are not activity yet.
 */
const activity = sql`coalesce(${posts.publishedAt}, ${posts.scheduledAt}, ${posts.createdAt})`;

export async function getAnalytics(userId: string, tz: string, days: number, now: Date = new Date()): Promise<AnalyticsData> {
  const db = getDb();
  const today = ymdOf(now, tz);
  const first = addDays(today, -(days - 1));
  const from = toInstant({ ...first, hour: 0, minute: 0 }, tz);
  const mine = and(eq(posts.userId, userId), ne(posts.status, "draft"), sql`${activity} >= ${from}`);

  const dayExpr = sql<string>`to_char((${activity} at time zone ${tz}), 'YYYY-MM-DD')`;

  const [statusRows, dayRows, platformRows, recentRows, upcomingRows, metricTotals, topRows, metricByPlatform] = await Promise.all([
    db.select({ status: posts.status, n: count() }).from(posts).where(mine).groupBy(posts.status),
    // Group by ordinal: a parameterised `AT TIME ZONE $n` in SELECT and GROUP BY are different expressions to Postgres.
    db.select({ day: dayExpr, status: posts.status, n: count() }).from(posts).where(mine).groupBy(sql`1`, sql`2`),
    db
      .select({ platform: postTargets.platform, status: postTargets.status, n: count() })
      .from(postTargets)
      .innerJoin(posts, eq(posts.id, postTargets.postId))
      .where(mine)
      .groupBy(postTargets.platform, postTargets.status),
    db
      .select()
      .from(posts)
      .where(and(mine, inArray(posts.status, ["published", "failed", "publishing"])))
      .orderBy(desc(activity))
      .limit(5),
    db
      .select()
      .from(posts)
      .where(and(eq(posts.userId, userId), eq(posts.status, "scheduled")))
      .orderBy(asc(posts.scheduledAt))
      .limit(5),
    db
      .select({
        likes: sum(postMetrics.likes),
        comments: sum(postMetrics.comments),
        impressions: sum(postMetrics.impressions),
        n: count(),
        updatedAt: max(postMetrics.fetchedAt),
      })
      .from(postMetrics)
      .innerJoin(postTargets, eq(postTargets.id, postMetrics.postTargetId))
      .innerJoin(posts, eq(posts.id, postTargets.postId))
      .where(mine),
    db
      .select({
        targetId: postTargets.id,
        postId: posts.id,
        platform: postTargets.platform,
        content: posts.content,
        url: postTargets.platformPostUrl,
        likes: postMetrics.likes,
        comments: postMetrics.comments,
        impressions: postMetrics.impressions,
      })
      .from(postMetrics)
      .innerJoin(postTargets, eq(postTargets.id, postMetrics.postTargetId))
      .innerJoin(posts, eq(posts.id, postTargets.postId))
      .where(mine)
      .orderBy(desc(sql`coalesce(${postMetrics.likes}, 0) + coalesce(${postMetrics.comments}, 0)`))
      .limit(5),
    db
      .select({
        platform: postTargets.platform,
        likes: sum(postMetrics.likes),
        comments: sum(postMetrics.comments),
        impressions: sum(postMetrics.impressions),
        n: count(),
      })
      .from(postMetrics)
      .innerJoin(postTargets, eq(postTargets.id, postMetrics.postTargetId))
      .innerJoin(posts, eq(posts.id, postTargets.postId))
      .where(mine)
      .groupBy(postTargets.platform),
  ]);

  const byStatus = Object.fromEntries(statusRows.map((r) => [r.status, r.n])) as Record<string, number>;
  const totals = {
    total: statusRows.reduce((s, r) => s + r.n, 0),
    published: byStatus.published ?? 0,
    scheduled: byStatus.scheduled ?? 0,
    failed: byStatus.failed ?? 0,
    publishing: byStatus.publishing ?? 0,
  };

  // Dense series: a day with no posts is a zero, not a gap.
  const series = new Map<string, DailyPoint>();
  for (let i = 0; i < days + LOOKAHEAD_DAYS; i += 1) {
    const key = ymdKey(addDays(first, i));
    series.set(key, { date: key, published: 0, scheduled: 0, failed: 0 });
  }
  for (const r of dayRows) {
    const point = series.get(r.day);
    if (!point) continue; // beyond the look-ahead window
    if (r.status === "published") point.published += r.n;
    else if (r.status === "failed") point.failed += r.n;
    else point.scheduled += r.n; // scheduled + publishing are both "in flight"
  }

  const platformMap = new Map<Platform, PlatformStat>();
  for (const r of platformRows) {
    const p = (platformMap.get(r.platform as Platform) ?? { platform: r.platform as Platform, total: 0, published: 0, scheduled: 0, failed: 0 }) as PlatformStat;
    p.total += r.n;
    if (r.status === "published") p.published += r.n;
    else if (r.status === "failed") p.failed += r.n;
    else p.scheduled += r.n;
    platformMap.set(p.platform, p);
  }

  const mt = metricTotals[0];
  const num = (v: string | null | undefined) => (v ? Number(v) : 0);

  return {
    range: { days, from: from.toISOString(), tz },
    totals,
    daily: [...series.values()],
    platforms: [...platformMap.values()].sort((a, b) => b.total - a.total),
    recent: await hydratePosts(recentRows),
    upcoming: await hydratePosts(upcomingRows),
    engagement: {
      available: (mt?.n ?? 0) > 0,
      likes: num(mt?.likes),
      comments: num(mt?.comments),
      impressions: num(mt?.impressions),
      updatedAt: mt?.updatedAt ? mt.updatedAt.toISOString() : null,
      top: topRows.map((r) => ({
        targetId: r.targetId,
        postId: r.postId,
        platform: r.platform as Platform,
        content: r.content,
        url: r.url,
        likes: r.likes ?? 0,
        comments: r.comments ?? 0,
        impressions: r.impressions ?? 0,
      })),
      byPlatform: metricByPlatform
        .map((r) => ({
          platform: r.platform as Platform,
          posts: r.n,
          likes: num(r.likes),
          comments: num(r.comments),
          impressions: num(r.impressions),
          // LinkedIn without stats approval and some Instagram media report no views: show "–", not 0.
          impressionsKnown: r.impressions !== null,
        }))
        .sort((a, b) => b.likes + b.comments - (a.likes + a.comments)),
    },
  };
}

