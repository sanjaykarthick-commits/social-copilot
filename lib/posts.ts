import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { PlanKey } from "@/lib/constants";
import { getDb } from "@/lib/db";
import { mediaAssets, postTargets, posts, socialAccounts, type MediaAsset, type Post, type SocialAccount } from "@/lib/db/schema";
import { AppError, notFound } from "@/lib/errors";
import { newScheduleToken, sendCancel, sendPublishNow, sendScheduled } from "@/lib/inngest/events";
import { platformName } from "@/lib/platforms/meta";
import { assertCanQueuePosts } from "@/lib/plans";
import { getPostDTO, type PostDTO } from "@/lib/posts-query";
import {
  MAX_LEAD_MS,
  MIN_LEAD_MS,
  validateForPublish,
  type Issue,
  type PostBody,
  type ValidationTarget,
} from "@/lib/validation/posts";

export interface Actor {
  userId: string;
  plan: PlanKey;
}

const label = (platform: string, username: string | null) => `${username ? `@${username}` : "account"} on ${platformName(platform)}`;

function failWith(issues: Issue[]): never {
  throw new AppError("VALIDATION", issues[0].message, 400, { issues });
}

async function loadOwned(userId: string, postId: string): Promise<Post> {
  const [row] = await getDb()
    .select()
    .from(posts)
    .where(and(eq(posts.id, postId), eq(posts.userId, userId)))
    .limit(1);
  if (!row) throw notFound("Post");
  return row;
}

async function hasPublishedTarget(postId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: postTargets.id })
    .from(postTargets)
    .where(and(eq(postTargets.postId, postId), eq(postTargets.status, "published")))
    .limit(1);
  return rows.length > 0;
}

/** Load and ownership-check the accounts and media a request refers to. */
async function resolveInputs(userId: string, body: PostBody, existingPostId?: string) {
  const db = getDb();
  const accountIds = body.targets.map((t) => t.socialAccountId);
  if (new Set(accountIds).size !== accountIds.length) {
    throw new AppError("VALIDATION", "Each account can only be selected once.", 400);
  }
  const accounts: SocialAccount[] = accountIds.length
    ? await db.select().from(socialAccounts).where(and(eq(socialAccounts.userId, userId), inArray(socialAccounts.id, accountIds)))
    : [];
  if (accounts.length !== accountIds.length) throw new AppError("VALIDATION", "One of the selected accounts was not found.", 400);

  let media: MediaAsset[] = [];
  if (body.mediaIds.length) {
    const rows = await db
      .select()
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.userId, userId),
          inArray(mediaAssets.id, body.mediaIds),
          existingPostId ? or(isNull(mediaAssets.postId), eq(mediaAssets.postId, existingPostId)) : isNull(mediaAssets.postId),
        ),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));
    media = body.mediaIds.map((id) => byId.get(id)).filter((m): m is MediaAsset => Boolean(m));
    if (media.length !== body.mediaIds.length) throw new AppError("VALIDATION", "One of the attached files was not found or is already used by another post.", 400);
  }
  return { accounts, media };
}

function assertPublishable(body: PostBody, accounts: SocialAccount[], media: MediaAsset[], now: Date) {
  if (body.mode === "draft") return;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const targets: ValidationTarget[] = body.targets.map((t) => {
    const a = byId.get(t.socialAccountId)!;
    return {
      socialAccountId: a.id,
      platform: a.platform as ValidationTarget["platform"],
      label: label(a.platform, a.username),
      postAsVideo: t.postAsVideo,
      contentOverride: t.contentOverride?.trim() ? t.contentOverride : null,
    };
  });
  const issues = validateForPublish({
    content: body.content,
    targets,
    media: media.map((m) => ({
      type: m.type === "video" ? ("video" as const) : ("image" as const),
      sizeBytes: m.sizeBytes,
      isGif: /\.gif($|\?)/i.test(m.url),
      width: m.width,
      height: m.height,
    })),
    mode: body.mode,
    scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
    now,
  });
  for (const a of accounts) {
    if (a.status !== "connected") {
      issues.push({ field: "target", message: `${label(a.platform, a.username)} needs to be reconnected first.`, socialAccountId: a.id });
    }
  }
  if (issues.length) failWith(issues);
}

/**
 * Change a post's state and tell the scheduler, in an order that can never leave a
 * post without a live run: (1) write the new state + token, (2) send the new event
 * (reverting the write if that fails), (3) only then cancel the old run. A stale
 * run that still fires is harmless because publishing re-checks the token.
 */
async function transition(post: Post, patch: Partial<typeof posts.$inferInsert>, send: (() => Promise<void>) | null) {
  const db = getDb();
  const oldToken = post.status === "scheduled" ? post.inngestEventId : null;
  await db
    .update(posts)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(posts.id, post.id));
  try {
    await send?.();
  } catch (e) {
    await db
      .update(posts)
      .set({
        status: post.status,
        scheduledAt: post.scheduledAt,
        queuedAt: post.queuedAt,
        inngestEventId: post.inngestEventId,
        failureReason: post.failureReason,
        updatedAt: new Date(),
      })
      .where(eq(posts.id, post.id));
    throw e;
  }
  if (oldToken) {
    sendCancel({ postId: post.id, token: oldToken }).catch((e) => console.warn("[posts] cancel of previous schedule failed (harmless):", e instanceof Error ? e.message : e));
  }
}

async function writeTargetsAndMedia(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  postId: string,
  body: PostBody,
  accounts: SocialAccount[],
  media: MediaAsset[],
) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  await tx.delete(postTargets).where(eq(postTargets.postId, postId));
  if (body.targets.length) {
    await tx.insert(postTargets).values(
      body.targets.map((t) => ({
        postId,
        socialAccountId: t.socialAccountId,
        platform: byId.get(t.socialAccountId)!.platform,
        postAsVideo: t.postAsVideo,
        contentOverride: t.contentOverride?.trim() ? t.contentOverride : null,
      })),
    );
  }
  // Release media that is no longer attached, then attach in order.
  const keep = media.map((m) => m.id);
  const current = await tx.select({ id: mediaAssets.id }).from(mediaAssets).where(eq(mediaAssets.postId, postId));
  const dropped = current.map((c) => c.id).filter((id) => !keep.includes(id));
  if (dropped.length) await tx.update(mediaAssets).set({ postId: null }).where(inArray(mediaAssets.id, dropped));
  for (const [i, m] of media.entries()) await tx.update(mediaAssets).set({ postId, position: i }).where(eq(mediaAssets.id, m.id));
}

function stateFor(body: PostBody, now: Date) {
  switch (body.mode) {
    case "draft":
      return { status: "draft" as const, scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null, token: null as string | null };
    case "schedule":
      return { status: "scheduled" as const, scheduledAt: new Date(body.scheduledAt!), token: newScheduleToken() };
    case "now":
      return { status: "publishing" as const, scheduledAt: now, token: newScheduleToken() };
  }
}

function dispatcher(postId: string, body: PostBody, state: ReturnType<typeof stateFor>) {
  if (body.mode === "draft") return null;
  if (body.mode === "schedule") {
    return () => sendScheduled({ postId, token: state.token!, scheduledAt: state.scheduledAt!.toISOString() });
  }
  return () => sendPublishNow({ postId, token: state.token! });
}

export async function createPost(actor: Actor, body: PostBody, now: Date = new Date()): Promise<PostDTO> {
  const { accounts, media } = await resolveInputs(actor.userId, body);
  assertPublishable(body, accounts, media, now);
  if (body.mode !== "draft") await assertCanQueuePosts(actor.userId, actor.plan);

  const state = stateFor(body, now);
  const db = getDb();
  const post = await db.transaction(async (tx) => {
    const [p] = await tx
      .insert(posts)
      .values({
        userId: actor.userId,
        content: body.content,
        // Always inserted as a draft: transition() promotes it only after the scheduler accepted it,
        // so a scheduler outage leaves the user's work saved as a draft instead of lost.
        status: "draft",
        scheduledAt: state.scheduledAt,
        queuedAt: null,
        inngestEventId: null,
      })
      .returning();
    await writeTargetsAndMedia(tx, p.id, body, accounts, media);
    return p;
  });

  if (body.mode !== "draft") {
    try {
      await transition(
        post,
        { status: state.status, scheduledAt: state.scheduledAt, queuedAt: now, inngestEventId: state.token },
        dispatcher(post.id, body, state),
      );
    } catch (e) {
      if (e instanceof AppError && e.code === "SCHEDULER_UNAVAILABLE") {
        throw new AppError(e.code, `${e.message} Your post was saved as a draft.`, e.status, { savedAsDraft: true, postId: post.id });
      }
      throw e;
    }
  }
  return (await getPostDTO(actor.userId, post.id))!;
}

/** Edit a draft / scheduled / failed post (full replacement, like the composer sends). */
export async function replacePost(actor: Actor, postId: string, body: PostBody, now: Date = new Date()): Promise<PostDTO> {
  const existing = await loadOwned(actor.userId, postId);
  if (existing.status === "publishing") throw new AppError("CONFLICT", "This post is being published right now.", 409);
  if (existing.status === "published") throw new AppError("CONFLICT", "Published posts can't be edited.", 409);
  if (await hasPublishedTarget(postId)) {
    throw new AppError("CONFLICT", "Part of this post is already published, so it can't be edited. You can retry the platforms that failed.", 409);
  }

  const { accounts, media } = await resolveInputs(actor.userId, body, postId);
  assertPublishable(body, accounts, media, now);
  if (body.mode !== "draft" && !existing.queuedAt) await assertCanQueuePosts(actor.userId, actor.plan);

  const state = stateFor(body, now);
  await getDb().transaction(async (tx) => {
    await tx.update(posts).set({ content: body.content, updatedAt: new Date() }).where(eq(posts.id, postId));
    await writeTargetsAndMedia(tx, postId, body, accounts, media);
  });

  const fresh = await loadOwned(actor.userId, postId);
  await transition(
    fresh,
    {
      status: state.status,
      scheduledAt: state.scheduledAt,
      queuedAt: existing.queuedAt ?? (body.mode === "draft" ? null : now),
      inngestEventId: state.token,
      failureReason: null,
    },
    dispatcher(postId, body, state),
  );
  return (await getPostDTO(actor.userId, postId))!;
}

/** Drag-and-drop on the calendar: move a scheduled post to a new time. */
export async function reschedulePost(actor: Actor, postId: string, scheduledAt: Date, now: Date = new Date()): Promise<PostDTO> {
  const existing = await loadOwned(actor.userId, postId);
  if (existing.status !== "scheduled") throw new AppError("CONFLICT", "Only scheduled posts can be moved.", 409);
  const lead = scheduledAt.getTime() - now.getTime();
  if (lead < MIN_LEAD_MS) throw new AppError("VALIDATION", "Pick a time at least a minute in the future.", 400);
  if (lead > MAX_LEAD_MS) throw new AppError("VALIDATION", "Posts can be scheduled up to a year ahead.", 400);

  const token = newScheduleToken();
  await transition(existing, { scheduledAt, inngestEventId: token }, () => sendScheduled({ postId, token, scheduledAt: scheduledAt.toISOString() }));
  return (await getPostDTO(actor.userId, postId))!;
}

/** "Publish now" for a draft or scheduled post, and "Retry" for a failed one (only unpublished platforms run). */
export async function publishPostNow(actor: Actor, postId: string, now: Date = new Date()): Promise<PostDTO> {
  const existing = await loadOwned(actor.userId, postId);
  if (existing.status === "publishing") throw new AppError("CONFLICT", "This post is already being published.", 409);
  if (existing.status === "published") throw new AppError("CONFLICT", "This post is already published.", 409);

  const db = getDb();
  const dto = (await getPostDTO(actor.userId, postId))!;
  const pending = dto.targets.filter((t) => t.status !== "published"); // a retry only re-runs these
  const [accountRows, mediaRows] = await Promise.all([
    pending.length
      ? db.select().from(socialAccounts).where(inArray(socialAccounts.id, pending.map((t) => t.socialAccountId)))
      : Promise.resolve([] as SocialAccount[]),
    db.select().from(mediaAssets).where(eq(mediaAssets.postId, postId)).orderBy(asc(mediaAssets.position)),
  ]);
  const body: PostBody = {
    content: dto.content,
    targets: pending.map((t) => ({ socialAccountId: t.socialAccountId, postAsVideo: t.postAsVideo, contentOverride: t.contentOverride })),
    mediaIds: dto.media.map((m) => m.id),
    mode: "now",
  };
  assertPublishable(body, accountRows, mediaRows, now);
  if (!existing.queuedAt) await assertCanQueuePosts(actor.userId, actor.plan);

  const token = newScheduleToken();
  if (existing.status === "failed") {
    // Retry only what has not been published yet.
    await getDb()
      .update(postTargets)
      .set({ status: "pending", error: null, updatedAt: new Date() })
      .where(and(eq(postTargets.postId, postId), eq(postTargets.status, "failed")));
  }
  await transition(
    existing,
    { status: "publishing", scheduledAt: now, queuedAt: existing.queuedAt ?? now, inngestEventId: token, failureReason: null },
    () => sendPublishNow({ postId, token }),
  );
  return (await getPostDTO(actor.userId, postId))!;
}

export async function deletePost(actor: Actor, postId: string): Promise<void> {
  const existing = await loadOwned(actor.userId, postId);
  if (existing.status === "publishing") throw new AppError("CONFLICT", "This post is being published right now. Try again in a moment.", 409);
  if (existing.status === "scheduled" && existing.inngestEventId) {
    await sendCancel({ postId, token: existing.inngestEventId }).catch((e) =>
      console.warn("[posts] cancel on delete failed (harmless, the run finds no post):", e instanceof Error ? e.message : e),
    );
  }
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.delete(mediaAssets).where(eq(mediaAssets.postId, postId));
    await tx.delete(posts).where(eq(posts.id, postId));
  });
}
