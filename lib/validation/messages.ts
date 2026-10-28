import { z } from "zod";

/** Shared by the Messages inbox (reply box state) and the API (enforcement). No server-only imports. */

/** Meta's standard messaging window: a business may reply until 24 hours after the person's last message. */
export const REPLY_WINDOW_MS = 24 * 3_600_000;
export const REPLY_WINDOW_CLOSED = "Instagram only allows replies within 24 hours of their last message.";
/** Instagram rejects text messages over 1,000 characters. */
export const DM_TEXT_LIMIT = 1_000;

export interface ReplyWindow {
  open: boolean;
  /** When the window closes (null when they never wrote to us, so there is no window). */
  endsAt: Date | null;
}

/** Whether a reply is allowed now, measured from the other person's last message (never ours). */
export function replyWindow(lastInboundAt: Date | string | null | undefined, now: Date = new Date()): ReplyWindow {
  if (!lastInboundAt) return { open: false, endsAt: null };
  const endsAt = new Date(new Date(lastInboundAt).getTime() + REPLY_WINDOW_MS);
  return { open: now.getTime() < endsAt.getTime(), endsAt };
}

export const conversationListQuerySchema = z.object({
  accountId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});
export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;

export const messageReplyBodySchema = z.object({
  text: z.string().trim().min(1, "Write a message first.").max(DM_TEXT_LIMIT, `Instagram messages can be at most ${DM_TEXT_LIMIT.toLocaleString()} characters.`),
  /** One per send attempt, generated in the browser: a double click or a retried request never sends twice. */
  idempotencyKey: z.string().min(8).max(100),
});
