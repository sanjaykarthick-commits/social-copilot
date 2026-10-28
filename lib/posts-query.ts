import { and, asc, desc, eq, inArray, sql, type SQL, count } from "drizzle-orm";
import type { Platform, PostStatus, TargetStatus } from "@/lib/constants";
import { POST_STATUSES } from "@/lib/constants";
import { getDb } from "@/lib/db";
import { mediaAssets, postTargets, posts, socialAccounts, type Post } from "@/lib/db/schema";
import type { PostListQuery } from "@/lib/validation/posts";

export interface TargetDTO {
  id: string;
  socialAccountId: string;
  platform: Platform;
  status: TargetStatus;
  platformPostUrl: string | null;
  error: string | null;
  postAsVideo: boolean;
  contentOverride: string | null;
  publishedAt: string | null;
  account: { username: string | null; displayName: string | null; profileImageUrl: string | null } | null;
}

export interface MediaDTO {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  type: "image" | "video";
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
}

export interface PostDTO {
  id: string;
  content: string;
  status: PostStatus;
  scheduledAt: string | null;
  publishedAt: string | null;
  queuedAt: string | null;
  failureReason: string | null;
  createdAt: string;
  targets: TargetDTO[];
  media: MediaDTO[];
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Hydrate posts with their targets (+ account display data) and media in two queries. */
export async function hydratePosts(rows: Post[]): Promise<PostDTO[]> {
  if (rows.length === 0) return [];
  const db = getDb();
  const ids = rows.map((r) => r.id);

  const [targetRows, mediaRows] = await Promise.all([
    db
      .select({
        t: postTargets,
        username: socialAccounts.username,
        displayName: socialAccounts.displayName,
        profileImageUrl: socialAccounts.profileImageUrl,
      })
      .from(postTargets)
      .leftJoin(socialAccounts, eq(socialAccounts.id, postTargets.socialAccountId))
      .where(inArray(postTargets.postId, ids))
      .orderBy(asc(postTargets.createdAt)),
    db.select().from(mediaAssets).where(inArray(mediaAssets.postId, ids)).orderBy(asc(mediaAssets.position)),
  ]);

  const targetsByPost = new Map<string, TargetDTO[]>();
  for (const { t, username, displayName, profileImageUrl } of targetRows) {
    const list = targetsByPost.get(t.postId) ?? [];
    list.push({
      id: t.id,
      socialAccountId: t.socialAccountId,
      platform: t.platform as Platform,
      status: t.status as TargetStatus,
      platformPostUrl: t.platformPostUrl,
      error: t.error,
      postAsVideo: t.postAsVideo,
      contentOverride: t.contentOverride,
      publishedAt: iso(t.publishedAt),
      account: username !== null || displayName !== null || profileImageUrl !== null ? { username, displayName, profileImageUrl } : null,
    });
    targetsByPost.set(t.postId, list);
  }
  const mediaByPost = new Map<string, MediaDTO[]>();
  for (const m of mediaRows) {
    if (!m.postId) continue;
    const list = mediaByPost.get(m.postId) ?? [];
    list.push({
      id: m.id,
      url: m.url,
      thumbnailUrl: m.thumbnailUrl,
      type: m.type === "video" ? "video" : "image",
      width: m.width,
      height: m.height,
      sizeBytes: m.sizeBytes,
    });
    mediaByPost.set(m.postId, list);
  }

  return rows.map((p) => ({
    id: p.id,
    content: p.content,
    status: p.status as PostStatus,
    scheduledAt: iso(p.scheduledAt),
    publishedAt: iso(p.publishedAt),
    queuedAt: iso(p.queuedAt),
    failureReason: p.failureReason,
    createdAt: p.createdAt.toISOString(),
    targets: targetsByPost.get(p.id) ?? [],
    media: mediaByPost.get(p.id) ?? [],
  }));
}

export async function getPostDTO(userId: string, postId: string): Promise<PostDTO | null> {
  const [row] = await getDb()
    .select()
    .from(posts)
    .where(and(eq(posts.id, postId), eq(posts.userId, userId)))
    .limit(1);
  return row ? (await hydratePosts([row]))[0] : null;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** The moment a post appears on the calendar: when it is (or was) due. */
const whenSql = sql<Date>`coalesce(${posts.scheduledAt}, ${posts.publishedAt})`;

export async function listPosts(userId: string, q: PostListQuery): Promise<{ posts: PostDTO[]; total: number }> {
  const db = getDb();
  const where: SQL[] = [eq(posts.userId, userId)];

  const statuses = (q.status ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is PostStatus => (POST_STATUSES as readonly string[]).includes(s));
  if (statuses.length) where.push(inArray(posts.status, statuses));

  if (q.q?.trim()) where.push(sql`${posts.content} ilike ${`%${escapeLike(q.q.trim())}%`} escape '\\'`);
  if (q.platform) {
    where.push(sql`exists (select 1 from ${postTargets} where ${postTargets.postId} = ${posts.id} and ${postTargets.platform} = ${q.platform})`);
  }
  if (q.from) where.push(sql`${whenSql} >= ${new Date(q.from)}`);
  if (q.to) where.push(sql`${whenSql} < ${new Date(q.to)}`);

  const cond = and(...where);
  const orderBy = q.order === "asc" ? asc(sql`coalesce(${posts.scheduledAt}, ${posts.createdAt})`) : desc(sql`coalesce(${posts.scheduledAt}, ${posts.createdAt})`);

  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(posts)
      .where(cond)
      .orderBy(orderBy, desc(posts.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: count() }).from(posts).where(cond),
  ]);
  return { posts: await hydratePosts(rows), total: total?.n ?? 0 };
}
