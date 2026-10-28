import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformConversation, PlatformMessage } from "@/lib/platforms/types";
import { hasDb, resetDb } from "./helpers/db";
import { makeAccount, makeUser } from "./helpers/fixtures";

const fetchConversations = vi.fn();
const sendMessage = vi.fn();
const capabilities = vi.fn(() => ({ metrics: true, comments: true, messages: true }));
vi.mock("@/lib/platforms", async (orig) => {
  const real = await orig<typeof import("@/lib/platforms")>();
  return {
    ...real,
    getAdapter: (p: string) =>
      p === "instagram"
        ? { platform: "instagram", implemented: true, publish: vi.fn(), refreshToken: vi.fn(), fetchConversations, sendMessage, capabilities }
        : real.getAdapter(p as never),
  };
});

import { getDb } from "@/lib/db";
import { conversations, directMessages, socialAccounts } from "@/lib/db/schema";
import { AppError } from "@/lib/errors";
import { getThread, listConversations, replyToConversation, syncAccountMessages, syncMessages } from "@/lib/messages";
import { PlatformError } from "@/lib/platforms/types";
import { REPLY_WINDOW_CLOSED } from "@/lib/validation/messages";

const NOW = new Date();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const msg = (id: string, fromMe: boolean, at: Date, text = `text ${id}`): PlatformMessage => ({ platformMessageId: id, fromMe, text, sentAt: at });
const conv = (id: string, messages: PlatformMessage[], over: Partial<PlatformConversation> = {}): PlatformConversation => ({
  platformConversationId: id,
  participant: { id: `IGSID-${id}`, handle: `fan_${id.toLowerCase()}`, name: null, imageUrl: null },
  updatedAt: messages.reduce((d, m) => (m.sentAt > d ? m.sentAt : d), new Date(0)),
  messages,
  ...over,
});

describe.skipIf(!hasDb)("Instagram messages", () => {
  let userId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDb();
    fetchConversations.mockReset();
    sendMessage.mockReset();
    capabilities.mockReset().mockReturnValue({ metrics: true, comments: true, messages: true });
    userId = (await makeUser("user_m")).id;
    accountId = (await makeAccount(userId, "instagram", "asha.makes")).id;
  });
  afterAll(resetDb);

  /** One conversation whose last message from them was `h` hours ago. */
  async function seed(h: number) {
    fetchConversations.mockResolvedValue([conv("T1", [msg("m1", false, hoursAgo(h), "Is the print still available?")])]);
    await syncAccountMessages(accountId, NOW);
    return (await listConversations(userId, { page: 1, pageSize: 30 })).conversations[0];
  }

  describe("sync", () => {
    it("stores conversations and messages, newest conversation first, with the reply window from their last message", async () => {
      fetchConversations.mockResolvedValue([
        conv("T1", [msg("a1", false, hoursAgo(5)), msg("a2", true, hoursAgo(4), "Yes!")]),
        conv("T2", [msg("b1", false, hoursAgo(1), "Hi")]),
      ]);
      const r = await syncAccountMessages(accountId, NOW);
      expect(r).toEqual({ accountId, fetched: 2, added: 2 }); // two new messages from other people
      expect(fetchConversations.mock.calls[0][1].since.getTime()).toBe(NOW.getTime() - 30 * 86_400_000);

      const list = await listConversations(userId, { page: 1, pageSize: 30 });
      expect(list.total).toBe(2);
      expect(list.awaiting).toBe(1);
      expect(list.conversations.map((c) => c.participant.handle)).toEqual(["fan_t2", "fan_t1"]);
      expect(list.conversations[1]).toMatchObject({
        lastMessage: { text: "Yes!", fromMe: true },
        lastInboundAt: hoursAgo(5).toISOString(),
        awaitingReply: false,
        account: { label: "@asha.makes" },
      });
      expect(list.conversations[0]).toMatchObject({ awaitingReply: true, lastMessage: { text: "Hi", fromMe: false } });

      const thread = await getThread(userId, list.conversations[1].id);
      expect(thread.messages.map((m) => [m.direction, m.status, m.text])).toEqual([
        ["inbound", "received", "text a1"],
        ["outbound", "sent", "Yes!"],
      ]);
      expect((await getDb().select().from(socialAccounts).where(eq(socialAccounts.id, accountId)))[0].lastMessageSyncAt).not.toBeNull();
    });

    it("re-syncing adds only new messages, and later syncs start just before the previous one", async () => {
      fetchConversations.mockResolvedValue([conv("T1", [msg("a1", false, hoursAgo(5))])]);
      await syncAccountMessages(accountId, NOW);
      fetchConversations.mockResolvedValue([conv("T1", [msg("a1", false, hoursAgo(5)), msg("a3", false, hoursAgo(1), "Hello?")])]);
      const later = new Date(NOW.getTime() + 15 * 60_000);
      const r = await syncAccountMessages(accountId, later);
      expect(r.added).toBe(1);
      expect(fetchConversations.mock.calls[1][1].since.getTime()).toBe(NOW.getTime() - 60 * 60_000);
      expect(await getDb().select().from(directMessages)).toHaveLength(2);
      expect(await getDb().select().from(conversations)).toHaveLength(1);
    });

    it("skips connections without message access instead of failing", async () => {
      capabilities.mockReturnValue({ metrics: true, comments: true, messages: false, messagesNote: "Reconnect and allow message access" } as never);
      expect(await syncAccountMessages(accountId, NOW)).toMatchObject({ added: 0, skipped: "Reconnect and allow message access" });
      expect(fetchConversations).not.toHaveBeenCalled();
    });

    it("one failing account never stops the others; 'Sync now' respects a per-account cooldown", async () => {
      const second = (await makeAccount(userId, "instagram", "second")).id;
      fetchConversations.mockImplementation(async (acc: { id: string }) => {
        if (acc.id === accountId) throw new PlatformError("rate limited", "rate_limit", true);
        return [];
      });
      const r = await syncMessages({ userId, now: NOW });
      expect(r.failed).toEqual([{ accountId, reason: "rate limited" }]);
      expect(r.results.map((x) => x.accountId)).toEqual([second]);
      fetchConversations.mockClear();
      expect((await syncMessages({ userId, now: new Date(NOW.getTime() + 10_000), respectCooldown: true })).results).toEqual([]);
      expect(fetchConversations).toHaveBeenCalledTimes(1); // only the one that failed (never marked synced)
    });
  });

  describe("24-hour reply window", () => {
    it("sends a reply within 24 hours of their last message", async () => {
      const c = await seed(23);
      sendMessage.mockResolvedValue({ platformMessageId: "mid.1" });
      const t = await replyToConversation(userId, c.id, { text: "Yes, it is!", idempotencyKey: "key-00000001" }, NOW);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0][1]).toEqual({ platformConversationId: "T1", participantId: "IGSID-T1" });
      expect(sendMessage.mock.calls[0][2]).toBe("Yes, it is!");
      expect(t.messages.at(-1)).toMatchObject({ direction: "outbound", status: "sent", text: "Yes, it is!" });
      expect(t.conversation).toMatchObject({ awaitingReply: false, lastMessage: { text: "Yes, it is!", fromMe: true } });
    });

    it("refuses after 24 hours, without calling Instagram or storing anything", async () => {
      const c = await seed(25);
      await expect(replyToConversation(userId, c.id, { text: "Sorry for the delay", idempotencyKey: "key-00000002" }, NOW)).rejects.toMatchObject({
        code: "REPLY_WINDOW_CLOSED",
        status: 400,
        message: REPLY_WINDOW_CLOSED,
      });
      expect(sendMessage).not.toHaveBeenCalled();
      expect((await getThread(userId, c.id)).messages).toHaveLength(1);
    });

    it("our own later message does not reopen the window: only theirs counts", async () => {
      fetchConversations.mockResolvedValue([conv("T1", [msg("m1", false, hoursAgo(30)), msg("m2", true, hoursAgo(1), "Following up")])]);
      await syncAccountMessages(accountId, NOW);
      const [c] = (await listConversations(userId, { page: 1, pageSize: 30 })).conversations;
      expect(c.lastInboundAt).toBe(hoursAgo(30).toISOString());
      await expect(replyToConversation(userId, c.id, { text: "again", idempotencyKey: "key-00000003" }, NOW)).rejects.toMatchObject({ code: "REPLY_WINDOW_CLOSED" });
    });

    it("a new message from them reopens it", async () => {
      const c = await seed(30);
      fetchConversations.mockResolvedValue([conv("T1", [msg("m1", false, hoursAgo(30)), msg("m9", false, hoursAgo(0.5), "Hello?")])]);
      await syncAccountMessages(accountId, NOW);
      sendMessage.mockResolvedValue({ platformMessageId: "mid.2" });
      await expect(replyToConversation(userId, c.id, { text: "Hi!", idempotencyKey: "key-00000004" }, NOW)).resolves.toBeTruthy();
    });
  });

  describe("reply idempotency", () => {
    it("a double click (same key, one after the other) sends once", async () => {
      const c = await seed(1);
      sendMessage.mockResolvedValue({ platformMessageId: "mid.1" });
      const first = await replyToConversation(userId, c.id, { text: "Yes!", idempotencyKey: "key-dup-0001" }, NOW);
      const second = await replyToConversation(userId, c.id, { text: "Yes!", idempotencyKey: "key-dup-0001" }, NOW);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(second.messages).toEqual(first.messages);
      expect(await getDb().select().from(directMessages).where(eq(directMessages.direction, "outbound"))).toHaveLength(1);
    });

    it("two concurrent requests with the same key send once", async () => {
      const c = await seed(1);
      sendMessage.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { platformMessageId: "mid.1" };
      });
      await Promise.all([
        replyToConversation(userId, c.id, { text: "Yes!", idempotencyKey: "key-race-001" }, NOW),
        replyToConversation(userId, c.id, { text: "Yes!", idempotencyKey: "key-race-001" }, NOW),
      ]);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it("a repeated key is answered even after the window closed (it reports the first attempt)", async () => {
      const c = await seed(23);
      sendMessage.mockResolvedValue({ platformMessageId: "mid.1" });
      await replyToConversation(userId, c.id, { text: "Yes!", idempotencyKey: "key-late-001" }, NOW);
      const t = await replyToConversation(userId, c.id, { text: "Yes!", idempotencyKey: "key-late-001" }, new Date(NOW.getTime() + 2 * 3_600_000));
      expect(t.messages.at(-1)).toMatchObject({ status: "sent" });
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it("a failed send stays visible with the platform's reason; 'Try again' (new key) sends", async () => {
      const c = await seed(1);
      sendMessage.mockRejectedValueOnce(new PlatformError("Sending the Instagram message: this person isn't available on Instagram right now.", "validation", false));
      const err = await replyToConversation(userId, c.id, { text: "Yes!", idempotencyKey: "key-fail-001" }, NOW).catch((e) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({ code: "REPLY_FAILED", status: 502 });
      const failed = (err.details as { thread: Awaited<ReturnType<typeof getThread>> }).thread.messages.at(-1)!;
      expect(failed).toMatchObject({ status: "failed", error: expect.stringContaining("isn't available") });
      expect((await getThread(userId, c.id)).conversation.awaitingReply).toBe(true); // a failed send is not an answer

      sendMessage.mockResolvedValue({ platformMessageId: "mid.2" });
      const t = await replyToConversation(userId, c.id, { text: "Yes!", idempotencyKey: "key-fail-002" }, NOW);
      expect(t.messages.map((m) => m.status)).toEqual(["received", "failed", "sent"]);
    });

    it("our reply read back by the next sync is not shown twice (same id, or a different id with the same text)", async () => {
      const c = await seed(1);
      sendMessage.mockResolvedValueOnce({ platformMessageId: "mid.1" }).mockResolvedValueOnce({ platformMessageId: "send-id-2" });
      await replyToConversation(userId, c.id, { text: "First", idempotencyKey: "key-echo-001" }, NOW);
      await replyToConversation(userId, c.id, { text: "Second", idempotencyKey: "key-echo-002" }, NOW);
      fetchConversations.mockResolvedValue([
        conv("T1", [msg("m1", false, hoursAgo(1), "Is the print still available?"), msg("mid.1", true, NOW, "First"), msg("thread-id-2", true, new Date(NOW.getTime() + 1000), "Second")]),
      ]);
      await syncAccountMessages(accountId, new Date(NOW.getTime() + 60_000));
      const t = await getThread(userId, c.id);
      expect(t.messages.map((m) => m.text)).toEqual(["Is the print still available?", "First", "Second"]);
    });
  });

  describe("scoping", () => {
    it("another user can neither list, read nor reply to a conversation", async () => {
      const c = await seed(1);
      const other = (await makeUser("user_other")).id;
      expect((await listConversations(other, { page: 1, pageSize: 30 })).total).toBe(0);
      await expect(getThread(other, c.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(replyToConversation(other, c.id, { text: "hi", idempotencyKey: "key-other-01" }, NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(getThread(userId, "not-a-uuid")).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("idempotency keys are per user: the same key from another user is a separate message", async () => {
      const c = await seed(1);
      const otherUser = (await makeUser("user_two")).id;
      const otherAccount = (await makeAccount(otherUser, "instagram", "ben")).id;
      fetchConversations.mockResolvedValue([conv("T9", [msg("z1", false, hoursAgo(1))])]);
      await syncAccountMessages(otherAccount, NOW);
      const [theirs] = (await listConversations(otherUser, { page: 1, pageSize: 30 })).conversations;
      sendMessage.mockResolvedValueOnce({ platformMessageId: "mid.a" }).mockResolvedValueOnce({ platformMessageId: "mid.b" });
      await replyToConversation(userId, c.id, { text: "A", idempotencyKey: "shared-key-1" }, NOW);
      await replyToConversation(otherUser, theirs.id, { text: "B", idempotencyKey: "shared-key-1" }, NOW);
      expect(sendMessage).toHaveBeenCalledTimes(2);
    });
  });
});
