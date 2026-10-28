import { and, count, desc, eq, inArray, isNotNull, max, sql } from "drizzle-orm";
import { z } from "zod";
import { getUsableAccount } from "@/lib/accounts";
import { MANUAL_SYNC_COOLDOWN_MS } from "@/lib/comments";
import type { Platform } from "@/lib/constants";
import { getDb } from "@/lib/db";
import { conversations, directMessages, socialAccounts, type DbConversation, type DirectMessage } from "@/lib/db/schema";
import { AppError, notFound } from "@/lib/errors";
import { getAdapter } from "@/lib/platforms";
import { platformName } from "@/lib/platforms/meta";
import { PlatformError, type PlatformConversation } from "@/lib/platforms/types";
import { DM_TEXT_LIMIT, REPLY_WINDOW_CLOSED, replyWindow, type ConversationListQuery } from "@/lib/validation/messages";

/** The first sync of an account looks back this far; later syncs start at the previous one. */
export const MESSAGE_WINDOW_DAYS = 30;
/** Later syncs re-read a little before the cursor, so a message that landed mid-sync is not missed. */
const SYNC_OVERLAP_MS = 60 * 60_000;
/** A reply we sent and the same message read back from Instagram are matched within this time. */
const ECHO_MATCH_MS = 10 * 60_000;
/** The thread view shows the latest messages only. */
const THREAD_LIMIT = 200;

export interface DirectMessageDTO {
  id: string;
  direction: "inbound" | "outbound";
  text: string;
  sentAt: string;
  status: "received" | "sending" | "sent" | "failed";
  error: string | null;
}

export interface ConversationDTO {
  id: string;
  platform: Platform;
  account: { id: string; label: string; imageUrl: string | null };
  participant: { handle: string | null; name: string | null; imageUrl: string | null };
  lastMessage: { text: string | null; at: string | null; fromMe: boolean };
  /** The other person's latest message: replies are allowed until 24 hours after it. */
  lastInboundAt: string | null;
  /** Their message is the latest one. */
  awaitingReply: boolean;
}

export interface ThreadDTO {
  conversation: ConversationDTO;
  messages: DirectMessageDTO[];
}

type AccountInfo = { id: string; username: string | null; displayName: string | null; profileImageUrl: string | null };
const accountInfo = { id: socialAccounts.id, username: socialAccounts.username, displayName: socialAccounts.displayName, profileImageUrl: socialAccounts.profileImageUrl };

function toDTO(c: DbConversation, a: AccountInfo): ConversationDTO {
  return {
    id: c.id,
    platform: c.platform as Platform,
    account: { id: a.id, label: a.username ? `@${a.username}` : (a.displayName ?? platformName(c.platform)), imageUrl: a.profileImageUrl },
    participant: { handle: c.participantHandle, name: c.participantName, imageUrl: c.participantImageUrl },
    lastMessage: { text: c.lastMessageText, at: c.lastMessageAt?.toISOString() ?? null, fromMe: c.lastMessageFromMe },
    lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
    awaitingReply: c.lastMessageAt !== null && !c.lastMessageFromMe,
  };
}

function toMessageDTO(m: DirectMessage): DirectMessageDTO {
  return {
    id: m.id,
    direction: m.direction as DirectMessageDTO["direction"],
    text: m.text,
    sentAt: m.sentAt.toISOString(),
    status: m.status as DirectMessageDTO["status"],
    error: m.error,
  };
}

export interface AccountMessageSyncResult {
  accountId: string;
  fetched: number;
  /** New messages from other people. */
  added: number;
  skipped?: string;
}

/** Pull conversations with recent activity for one account and merge them into the Messages inbox. */
export async function syncAccountMessages(accountId: string, now = new Date()): Promise<AccountMessageSyncResult> {
  const db = getDb();
  const [row] = await db.select().from(socialAccounts).where(eq(socialAccounts.id, accountId)).limit(1);
  if (!row) return { accountId, fetched: 0, added: 0, skipped: "account removed" };
  const adapter = getAdapter(row.platform as Platform);
  if (!adapter.fetchConversations) return { accountId, fetched: 0, added: 0, skipped: "platform has no message support" };
  const caps = adapter.capabilities?.({ scopes: row.scopes });
  if (!caps?.messages) return { accountId, fetched: 0, added: 0, skipped: caps?.messagesNote ?? "messages not available for this connection" };

  const account = await getUsableAccount(accountId);
  const since = row.lastMessageSyncAt
    ? new Date(row.lastMessageSyncAt.getTime() - SYNC_OVERLAP_MS)
    : new Date(now.getTime() - MESSAGE_WINDOW_DAYS * 86_400_000);
  const found = await adapter.fetchConversations(account, { since });
  let added = 0;
  for (const c of found) added += await upsertConversation(row.userId, accountId, row.platform as Platform, c);
  await db.update(socialAccounts).set({ lastMessageSyncAt: now }).where(eq(socialAccounts.id, accountId));
  return { accountId, fetched: found.length, added };
}

/** Store one conversation and its new messages. Returns how many new messages came from the other person. */
export async function upsertConversation(userId: string, accountId: string, platform: Platform, c: PlatformConversation): Promise<number> {
  const db = getDb();
  const [conv] = await db
    .insert(conversations)
    .values({
      userId,
      socialAccountId: accountId,
      platform,
      platformConversationId: c.platformConversationId,
      participantId: c.participant.id,
      participantHandle: c.participant.handle,
      participantName: c.participant.name,
      participantImageUrl: c.participant.imageUrl,
    })
    .onConflictDoUpdate({
      target: [conversations.socialAccountId, conversations.platformConversationId],
      set: {
        participantId: sql`excluded.participant_id`,
        participantHandle: sql`coalesce(excluded.participant_handle, ${conversations.participantHandle})`,
        participantName: sql`coalesce(excluded.participant_name, ${conversations.participantName})`,
        participantImageUrl: sql`coalesce(excluded.participant_image_url, ${conversations.participantImageUrl})`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: conversations.id });

  let added = 0;
  const ids = c.messages.map((m) => m.platformMessageId);
  if (ids.length) {
    const known = new Set(
      (
        await db
          .select({ id: directMessages.platformMessageId })
          .from(directMessages)
          .where(and(eq(directMessages.conversationId, conv.id), inArray(directMessages.platformMessageId, ids)))
      ).map((r) => r.id),
    );
    const fresh = c.messages.filter((m) => !known.has(m.platformMessageId));
    // Our own replies come back on the next sync. If Instagram reports them under another id than the send
    // returned, match them to the row stored when sending (same text, close in time) instead of showing them twice.
    const unmatched = fresh.some((m) => m.fromMe)
      ? await db
          .select()
          .from(directMessages)
          .where(and(eq(directMessages.conversationId, conv.id), eq(directMessages.direction, "outbound"), inArray(directMessages.status, ["sending", "sent"])))
      : [];
    const values: (typeof directMessages.$inferInsert)[] = [];
    for (const m of fresh) {
      if (m.fromMe) {
        const i = unmatched.findIndex((o) => !ids.includes(o.platformMessageId ?? "") && o.text.trim() === m.text.trim() && Math.abs(o.sentAt.getTime() - m.sentAt.getTime()) < ECHO_MATCH_MS);
        if (i >= 0) {
          const [own] = unmatched.splice(i, 1);
          await db.update(directMessages).set({ platformMessageId: m.platformMessageId, status: "sent", error: null, updatedAt: new Date() }).where(eq(directMessages.id, own.id));
          continue;
        }
      }
      values.push({
        conversationId: conv.id,
        userId,
        platformMessageId: m.platformMessageId,
        direction: m.fromMe ? "outbound" : "inbound",
        text: m.text,
        sentAt: m.sentAt,
        status: m.fromMe ? "sent" : "received",
      });
    }
    if (values.length) {
      const inserted = await db
        .insert(directMessages)
        .values(values)
        .onConflictDoNothing({ target: [directMessages.conversationId, directMessages.platformMessageId] })
        .returning({ direction: directMessages.direction });
      added = inserted.filter((r) => r.direction === "inbound").length;
    }
  }
  await refreshSummary(conv.id);
  return added;
}

/** Recompute the list preview and the reply window from the stored messages. */
async function refreshSummary(conversationId: string) {
  const db = getDb();
  const delivered = and(eq(directMessages.conversationId, conversationId), inArray(directMessages.status, ["received", "sent"]));
  const [[latest], [inbound]] = await Promise.all([
    db.select().from(directMessages).where(delivered).orderBy(desc(directMessages.sentAt)).limit(1),
    db
      .select({ at: max(directMessages.sentAt) })
      .from(directMessages)
      .where(and(eq(directMessages.conversationId, conversationId), eq(directMessages.direction, "inbound"))),
  ]);
  await db
    .update(conversations)
    .set({
      lastMessageText: latest?.text ?? null,
      lastMessageAt: latest?.sentAt ?? null,
      lastMessageFromMe: latest?.direction === "outbound",
      lastInboundAt: inbound?.at ?? null,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));
}

/** Every connected account with message support (or one user's), one at a time; a failing account never stops the others. */
export async function syncMessages(opts: { userId?: string; now?: Date; respectCooldown?: boolean } = {}) {
  const now = opts.now ?? new Date();
  const rows = await getDb()
    .select({ id: socialAccounts.id, platform: socialAccounts.platform, lastSync: socialAccounts.lastMessageSyncAt })
    .from(socialAccounts)
    .where(and(eq(socialAccounts.status, "connected"), opts.userId ? eq(socialAccounts.userId, opts.userId) : undefined));
  const results: AccountMessageSyncResult[] = [];
  const failed: { accountId: string; reason: string }[] = [];
  for (const r of rows) {
    if (!getAdapter(r.platform as Platform).fetchConversations) continue;
    if (opts.respectCooldown && r.lastSync && now.getTime() - r.lastSync.getTime() < MANUAL_SYNC_COOLDOWN_MS) continue;
    try {
      results.push(await syncAccountMessages(r.id, now));
    } catch (e) {
      failed.push({ accountId: r.id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { results, failed, added: results.reduce((n, r) => n + r.added, 0) };
}

export async function listConversations(userId: string, q: ConversationListQuery) {
  const db = getDb();
  const where = and(eq(conversations.userId, userId), isNotNull(conversations.lastMessageAt), q.accountId ? eq(conversations.socialAccountId, q.accountId) : undefined);
  const [rows, [{ n: total }], [{ n: awaiting }]] = await Promise.all([
    db
      .select({ c: conversations, a: accountInfo })
      .from(conversations)
      .innerJoin(socialAccounts, eq(socialAccounts.id, conversations.socialAccountId))
      .where(where)
      .orderBy(desc(conversations.lastMessageAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: count() }).from(conversations).where(where),
    db
      .select({ n: count() })
      .from(conversations)
      .where(and(eq(conversations.userId, userId), isNotNull(conversations.lastMessageAt), eq(conversations.lastMessageFromMe, false))),
  ]);
  return { conversations: rows.map((r) => toDTO(r.c, r.a)), total, awaiting };
}

async function ownedConversation(userId: string, conversationId: string) {
  if (!z.uuid().safeParse(conversationId).success) throw notFound("Conversation");
  const [row] = await getDb()
    .select({ c: conversations, a: accountInfo })
    .from(conversations)
    .innerJoin(socialAccounts, eq(socialAccounts.id, conversations.socialAccountId))
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .limit(1);
  if (!row) throw notFound("Conversation");
  return row;
}

export async function getThread(userId: string, conversationId: string): Promise<ThreadDTO> {
  const { c, a } = await ownedConversation(userId, conversationId);
  const latest = await getDb()
    .select()
    .from(directMessages)
    .where(eq(directMessages.conversationId, c.id))
    .orderBy(desc(directMessages.sentAt), desc(directMessages.createdAt))
    .limit(THREAD_LIMIT);
  return { conversation: toDTO(c, a), messages: latest.reverse().map(toMessageDTO) };
}

/**
 * Send a reply now (the user is waiting for it). Only inside Instagram's 24-hour window, and the
 * idempotency key makes a double click or a retried request return the first attempt instead of sending twice.
 */
export async function replyToConversation(userId: string, conversationId: string, input: { text: string; idempotencyKey: string }, now = new Date()): Promise<ThreadDTO> {
  const db = getDb();
  const { c } = await ownedConversation(userId, conversationId);

  // A repeat of an attempt that already happened: report it, even if the window has closed since.
  const [repeat] = await db
    .select({ id: directMessages.id })
    .from(directMessages)
    .where(and(eq(directMessages.userId, userId), eq(directMessages.idempotencyKey, input.idempotencyKey)))
    .limit(1);
  if (repeat) return getThread(userId, conversationId);

  if (!replyWindow(c.lastInboundAt, now).open) throw new AppError("REPLY_WINDOW_CLOSED", REPLY_WINDOW_CLOSED, 400);
  if (input.text.length > DM_TEXT_LIMIT) throw new AppError("VALIDATION", `Instagram messages can be at most ${DM_TEXT_LIMIT.toLocaleString()} characters.`, 400);

  const [msg] = await db
    .insert(directMessages)
    .values({ conversationId, userId, direction: "outbound", text: input.text, sentAt: now, status: "sending", idempotencyKey: input.idempotencyKey })
    .onConflictDoNothing({ target: [directMessages.userId, directMessages.idempotencyKey] })
    .returning();
  if (!msg) return getThread(userId, conversationId); // a concurrent request with the same key got there first

  const platform = c.platform as Platform;
  const adapter = getAdapter(platform);
  try {
    if (!adapter.sendMessage) throw new PlatformError(`Messages are not supported on ${platformName(platform)}.`, "validation", false);
    const account = await getUsableAccount(c.socialAccountId);
    const sent = await adapter.sendMessage(account, { platformConversationId: c.platformConversationId, participantId: c.participantId }, input.text);
    await db.transaction(async (tx) => {
      // A sync that ran meanwhile may already have stored this message from Instagram's side: keep ours.
      await tx
        .delete(directMessages)
        .where(and(eq(directMessages.conversationId, conversationId), eq(directMessages.platformMessageId, sent.platformMessageId), sql`${directMessages.id} <> ${msg.id}`));
      await tx.update(directMessages).set({ status: "sent", platformMessageId: sent.platformMessageId, updatedAt: new Date() }).where(eq(directMessages.id, msg.id));
    });
    await refreshSummary(conversationId);
  } catch (e) {
    const message = e instanceof PlatformError || e instanceof AppError ? e.message : "The message could not be sent.";
    await db.update(directMessages).set({ status: "failed", error: message.slice(0, 1000), updatedAt: new Date() }).where(eq(directMessages.id, msg.id));
    if (!(e instanceof PlatformError) && !(e instanceof AppError)) console.error("[messages] send failed", e);
    throw new AppError("REPLY_FAILED", message, 502, { thread: await getThread(userId, conversationId) });
  }
  return getThread(userId, conversationId);
}
