import { describe, expect, it } from "vitest";
import { DM_TEXT_LIMIT, messageReplyBodySchema, REPLY_WINDOW_CLOSED, REPLY_WINDOW_MS, replyWindow } from "@/lib/validation/messages";

const NOW = new Date("2026-10-28T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("Instagram's 24-hour reply window", () => {
  it("is open until exactly 24 hours after their last message, then closed", () => {
    expect(REPLY_WINDOW_MS).toBe(24 * 3_600_000);
    expect(replyWindow(hoursAgo(1), NOW)).toEqual({ open: true, endsAt: new Date("2026-10-29T11:00:00Z") });
    expect(replyWindow(new Date(NOW.getTime() - REPLY_WINDOW_MS + 1), NOW).open).toBe(true);
    expect(replyWindow(hoursAgo(24), NOW).open).toBe(false);
    expect(replyWindow(hoursAgo(30), NOW)).toEqual({ open: false, endsAt: new Date("2026-10-28T06:00:00Z") });
  });

  it("is closed when they never wrote (a business cannot start a conversation)", () => {
    expect(replyWindow(null, NOW)).toEqual({ open: false, endsAt: null });
    expect(replyWindow(undefined, NOW).open).toBe(false);
  });

  it("accepts ISO strings from the API", () => {
    expect(replyWindow(hoursAgo(2).toISOString(), NOW).open).toBe(true);
  });

  it("uses Meta's wording", () => {
    expect(REPLY_WINDOW_CLOSED).toBe("Instagram only allows replies within 24 hours of their last message.");
  });
});

describe("message reply body", () => {
  it("needs text within Instagram's limit and an idempotency key", () => {
    expect(messageReplyBodySchema.safeParse({ text: "  hi  ", idempotencyKey: "k-12345678" })).toMatchObject({ success: true, data: { text: "hi" } });
    expect(messageReplyBodySchema.safeParse({ text: "   ", idempotencyKey: "k-12345678" }).success).toBe(false);
    expect(messageReplyBodySchema.safeParse({ text: "x".repeat(DM_TEXT_LIMIT + 1), idempotencyKey: "k-12345678" }).success).toBe(false);
    expect(messageReplyBodySchema.safeParse({ text: "hi" }).success).toBe(false);
  });
});
