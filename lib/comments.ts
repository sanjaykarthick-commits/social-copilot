import { and, count, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getUsableAccount } from "@/lib/accounts";
import type { Platform } from "@/lib/constants";
import { getDb } from "@/lib/db";
import { commentReplies, comments, postTargets, socialAccounts, type CommentReply, type DbComment } from "@/lib/db/schema";
import { AppError, notFound } from "@/lib/errors";
import { getAdapter } from "@/lib/platforms";
import { platformName } from "@/lib/platforms/meta";
import { PlatformError, type PlatformComment } from "@/lib/platforms/types";
import { replyLimit, type CommentListQuery, type CommentStatus } from "@/lib/validation/comments";

/** Comments older than this are not pulled into the inbox. */
export const COMMENT_WINDOW_DAYS = 30;
/** "Sync now" is limited per account so a busy button cannot burn platform quota. */
export const MANUAL_SYNC_COOLDOWN_MS = 60_000;

export interface CommentReplyDTO {
  id: string;
  text: string;
  status: "sending" | "sent" | "failed";
  error: string | null;
  createdAt: string;
}

export interface CommentDTO {
  id: string;
  platform: Platform;
  account: { id: string; label: string; imageUrl: string | null };
  status: CommentStatus;
  text: string;
  authorName: string | null;
  authorHandle: string | null;
  authorImageUrl: string | null;
  likeCount: number | null;
  commentedAt: string;
  repliedAt: string | null;
  post: { url: string | null; title: string | null; thumbnailUrl: string | null; fromSocialCopilot: boolean };
  replies: CommentReplyDTO[];
}

const firstLine = (s: string) => s.trim().split("\n")[0]?.slice(0, 140) || null;

function toReplyDTO(r: CommentReply): CommentReplyDTO {
  return { id: r.id, text: r.text, status: r.status as CommentReplyDTO["status"], error: r.error, createdAt: r.createdAt.toISOString() };
}

type AccountInfo = { id: string; username: string | null; displayName: string | null; profileImageUrl: string | null };

function toDTO(c: DbComment, account: AccountInfo, replies: CommentReply[]): CommentDTO {
  return {
    id: c.id,
    platform: c.platform as Platform,
    account: { id: account.id, label: account.username ? `@${account.username}` : (account.displayName ?? platformName(c.platform)), imageUrl: account.profileImageUrl },
    status: c.status as CommentStatus,
    text: c.text,
    authorName: c.authorName,
    authorHandle: c.authorHandle,
    authorImageUrl: c.authorImageUrl,
    likeCount: c.likeCount,
    commentedAt: c.commentedAt.toISOString(),
    repliedAt: c.repliedAt?.toISOString() ?? null,
    post: { url: c.postUrl, title: c.postTitle, thumbnailUrl: c.postThumbnailUrl, fromSocialCopilot: c.postTargetId !== null },
    replies: replies.map(toReplyDTO),
  };
}

export interface AccountSyncResult {
  accountId: string;
  fetched: number;
  added: number;
  skipped?: string;
}

/** Pull recent comments for one account and merge them into the inbox. Never reopens a comment the user handled. */
export async function syncAccountComments(accountId: string, now = new Date()): Promise<AccountSyncResult> {
  const db = getDb();
  const [row] = await db.select().from(socialAccounts).where(eq(socialAccounts.id, accountId)).limit(1);
  if (!row) return { accountId, fetched: 0, added: 0, skipped: "account removed" };
  const adapter = getAdapter(row.platform as Platform);
  if (!adapter.fetchComments) return { accountId, fetched: 0, added: 0, skipped: "platform has no comment support" };
  const caps = adapter.capabilities?.({ scopes: row.scopes });
  if (caps && !caps.comments) return { accountId, fetched: 0, added: 0, skipped: caps.note ?? "comments not available for this connection" };

  const account = await getUsableAccount(accountId);
  const since = new Date(now.getTime() - COMMENT_WINDOW_DAYS * 86_400_000);
  const ours = await db
    .select({ id: postTargets.id, platformPostId: postTargets.platformPostId, content: sql<string>`coalesce(${postTargets.contentOverride}, (select content from posts where posts.id = ${postTargets.postId}))` })
    .from(postTargets)
    .where(and(eq(postTargets.socialAccountId, accountId), eq(postTargets.status, "published"), isNotNull(postTargets.platformPostId), gte(postTargets.publishedAt, since)))
    .orderBy(desc(postTargets.publishedAt))
    .limit(50);
  const byPostId = new Map(ours.map((t) => [t.platformPostId!, t]));

  const found = await adapter.fetchComments(account, { knownPostIds: ours.map((t) => t.platformPostId!), since });
  const added = await upsertComments(row.userId, accountId, row.platform as Platform, found, byPostId);
  await db.update(socialAccounts).set({ lastCommentSyncAt: now }).where(eq(socialAccounts.id, accountId));
  return { accountId, fetched: found.length, added };
}

export async function upsertComments(
  userId: string,
  accountId: string,
  platform: Platform,
  found: PlatformComment[],
  ours: Map<string, { id: string; content: string }> = new Map(),
): Promise<number> {
  if (found.length === 0) return 0;
  const db = getDb();
  const values = found.map((c) => {
    const own = ours.get(c.platformPostId);
    return {
      userId,
      socialAccountId: accountId,
      platform,
      platformCommentId: c.platformCommentId,
      platformPostId: c.platformPostId,
      postTargetId: own?.id ?? null,
      postUrl: c.postUrl,
      // Our own text is the best title (Instagram does not return captions to apps using Instagram Login).
      postTitle: (own ? firstLine(own.content) : null) ?? c.postTitle,
      postThumbnailUrl: c.postThumbnailUrl,
      authorName: c.authorName,
      authorHandle: c.authorHandle,
      authorImageUrl: c.authorImageUrl,
      text: c.text,
      likeCount: c.likeCount,
      commentedAt: c.createdAt,
      status: c.ownerReplied ? "replied" : "open",
      repliedAt: c.ownerReplied ? c.createdAt : null,
      extra: c.extra ?? {},
    };
  });
  const inserted = await db
    .insert(comments)
    .values(values)
    .onConflictDoUpdate({
      target: [comments.socialAccountId, comments.platformCommentId],
      set: {
        text: sql`excluded.text`,
        likeCount: sql`excluded.like_count`,
        authorName: sql`coalesce(excluded.author_name, ${comments.authorName})`,
        authorImageUrl: sql`coalesce(excluded.author_image_url, ${comments.authorImageUrl})`,
        postTitle: sql`coalesce(${comments.postTitle}, excluded.post_title)`,
        postThumbnailUrl: sql`coalesce(excluded.post_thumbnail_url, ${comments.postThumbnailUrl})`,
        // Answered on the platform itself: move it out of "needs reply". Never reopen or un-archive.
        status: sql`case when excluded.status = 'replied' and ${comments.status} = 'open' then 'replied' else ${comments.status} end`,
        repliedAt: sql`coalesce(${comments.repliedAt}, excluded.replied_at)`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: comments.id, inserted: sql<boolean>`(xmax = 0)` });
  return inserted.filter((r) => r.inserted).length;
}

/** Every connected account (or one user's), one at a time; a failing account never stops the others. */
export async function syncComments(opts: { userId?: string; now?: Date; respectCooldown?: boolean } = {}) {
  const now = opts.now ?? new Date();
  const db = getDb();
  const rows = await db
    .select({ id: socialAccounts.id, platform: socialAccounts.platform, lastSync: socialAccounts.lastCommentSyncAt })
    .from(socialAccounts)
    .where(and(eq(socialAccounts.status, "connected"), opts.userId ? eq(socialAccounts.userId, opts.userId) : undefined));
  const results: AccountSyncResult[] = [];
  const failed: { accountId: string; reason: string }[] = [];
  for (const r of rows) {
    if (!getAdapter(r.platform as Platform).fetchComments) continue;
    if (opts.respectCooldown && r.lastSync && now.getTime() - r.lastSync.getTime() < MANUAL_SYNC_COOLDOWN_MS) continue;
    try {
      results.push(await syncAccountComments(r.id, now));
    } catch (e) {
      failed.push({ accountId: r.id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { results, failed, added: results.reduce((n, r) => n + r.added, 0) };
}

export async function listComments(userId: string, q: CommentListQuery) {
  const db = getDb();
  const where = and(
    eq(comments.userId, userId),
    q.status === "all" ? undefined : eq(comments.status, q.status),
    q.platform ? eq(comments.platform, q.platform) : undefined,
    q.accountId ? eq(comments.socialAccountId, q.accountId) : undefined,
  );
  const [rows, [{ n: total }], counts] = await Promise.all([
    db
      .select({ c: comments, a: { id: socialAccounts.id, username: socialAccounts.username, displayName: socialAccounts.displayName, profileImageUrl: socialAccounts.profileImageUrl } })
      .from(comments)
      .innerJoin(socialAccounts, eq(socialAccounts.id, comments.socialAccountId))
      .where(where)
      .orderBy(desc(comments.commentedAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: count() }).from(comments).where(where),
    db.select({ status: comments.status, n: count() }).from(comments).where(eq(comments.userId, userId)).groupBy(comments.status),
  ]);
  const replies = rows.length
    ? await db.select().from(commentReplies).where(inArray(commentReplies.commentId, rows.map((r) => r.c.id))).orderBy(commentReplies.createdAt)
    : [];
  const byComment = new Map<string, CommentReply[]>();
  for (const r of replies) byComment.set(r.commentId, [...(byComment.get(r.commentId) ?? []), r]);
  const tally = Object.fromEntries(counts.map((c) => [c.status, c.n])) as Partial<Record<CommentStatus, number>>;
  return {
    comments: rows.map((r) => toDTO(r.c, r.a, byComment.get(r.c.id) ?? [])),
    total,
    counts: { open: tally.open ?? 0, replied: tally.replied ?? 0, archived: tally.archived ?? 0 },
  };
}

export async function countOpenComments(userId: string): Promise<number> {
  const [r] = await getDb().select({ n: count() }).from(comments).where(and(eq(comments.userId, userId), eq(comments.status, "open")));
  return r?.n ?? 0;
}

async function ownedComment(userId: string, commentId: string) {
  if (!z.uuid().safeParse(commentId).success) throw notFound("Comment");
  const [row] = await getDb()
    .select({ c: comments, a: { id: socialAccounts.id, username: socialAccounts.username, displayName: socialAccounts.displayName, profileImageUrl: socialAccounts.profileImageUrl } })
    .from(comments)
    .innerJoin(socialAccounts, eq(socialAccounts.id, comments.socialAccountId))
    .where(and(eq(comments.id, commentId), eq(comments.userId, userId)))
    .limit(1);
  if (!row) throw notFound("Comment");
  return row;
}

async function commentDTO(userId: string, commentId: string): Promise<CommentDTO> {
  const { c, a } = await ownedComment(userId, commentId);
  const replies = await getDb().select().from(commentReplies).where(eq(commentReplies.commentId, c.id)).orderBy(commentReplies.createdAt);
  return toDTO(c, a, replies);
}

export async function setCommentStatus(userId: string, commentId: string, status: "open" | "archived"): Promise<CommentDTO> {
  await ownedComment(userId, commentId);
  // Reopening a comment that already has a sent reply puts it back under "Replied", not "Needs reply".
  await getDb()
    .update(comments)
    .set({ status: status === "open" ? sql`case when ${comments.repliedAt} is not null then 'replied' else 'open' end` : "archived", updatedAt: new Date() })
    .where(eq(comments.id, commentId));
  return commentDTO(userId, commentId);
}

/**
 * Send a reply now (not queued: the user is waiting for it). The idempotency key makes a double click
 * or a retried request return the first attempt instead of replying twice.
 */
export async function replyToComment(userId: string, commentId: string, input: { text: string; idempotencyKey: string }): Promise<CommentDTO> {
  const db = getDb();
  const { c } = await ownedComment(userId, commentId);
  const platform = c.platform as Platform;
  const limit = replyLimit(platform);
  if (input.text.length > limit) throw new AppError("VALIDATION", `${platformName(platform)} replies can be at most ${limit.toLocaleString()} characters.`, 400);

  const [reply] = await db
    .insert(commentReplies)
    .values({ commentId, userId, text: input.text, idempotencyKey: input.idempotencyKey, status: "sending" })
    .onConflictDoNothing({ target: [commentReplies.userId, commentReplies.idempotencyKey] })
    .returning();
  if (!reply) return commentDTO(userId, commentId); // already sent (or being sent) for this key

  const adapter = getAdapter(platform);
  try {
    if (!adapter.replyToComment) throw new PlatformError(`Replying is not supported on ${platformName(platform)}.`, "validation", false);
    const account = await getUsableAccount(c.socialAccountId);
    const sent = await adapter.replyToComment(account, { platformCommentId: c.platformCommentId, platformPostId: c.platformPostId, extra: c.extra }, input.text);
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.update(commentReplies).set({ status: "sent", platformReplyId: sent.platformReplyId, updatedAt: now }).where(eq(commentReplies.id, reply.id));
      await tx.update(comments).set({ status: "replied", repliedAt: now, updatedAt: now }).where(eq(comments.id, commentId));
    });
  } catch (e) {
    const message = e instanceof PlatformError || e instanceof AppError ? e.message : "The reply could not be sent.";
    await db.update(commentReplies).set({ status: "failed", error: message.slice(0, 1000), updatedAt: new Date() }).where(eq(commentReplies.id, reply.id));
    if (!(e instanceof PlatformError) && !(e instanceof AppError)) console.error("[comments] reply failed", e);
    throw new AppError("REPLY_FAILED", message, 502, { comment: await commentDTO(userId, commentId) });
  }
  return commentDTO(userId, commentId);
}
