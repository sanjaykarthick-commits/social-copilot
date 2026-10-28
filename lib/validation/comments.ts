import { z } from "zod";
import type { Platform } from "@/lib/constants";

/** Shared by the inbox (live counter) and the API. No server-only imports. */

export const COMMENT_STATUSES = ["open", "replied", "archived"] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

/** Longest reply each platform accepts. */
export const REPLY_LIMITS: Partial<Record<Platform, number>> = {
  youtube: 10_000,
  instagram: 2_200,
  linkedin: 1_250,
};
export const replyLimit = (p: Platform) => REPLY_LIMITS[p] ?? 1_000;

export const commentListQuerySchema = z.object({
  status: z.enum([...COMMENT_STATUSES, "all"]).default("open"),
  platform: z.string().optional(),
  accountId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type CommentListQuery = z.infer<typeof commentListQuerySchema>;

export const replyBodySchema = z.object({
  text: z.string().trim().min(1, "Write a reply first.").max(10_000),
  /** One per reply attempt, generated in the browser. */
  idempotencyKey: z.string().min(8).max(100),
});

export const commentPatchSchema = z.object({ status: z.enum(["open", "archived"]) });
