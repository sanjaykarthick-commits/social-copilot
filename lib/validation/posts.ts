import { z } from "zod";
import type { Platform } from "@/lib/constants";
import { countChars } from "@/lib/platforms/length";
import { PLATFORM_META } from "@/lib/platforms/meta";

/**
 * Shared by the composer (live feedback) and the API (enforcement), so the two
 * can never disagree. No server-only imports allowed in this file.
 */

export const MIN_LEAD_MS = 60_000; // must be at least a minute in the future
export const MAX_LEAD_MS = 365 * 86_400_000;

/** Instagram allows up to 3 collaborators on a feed photo, reel or carousel (not stories). */
export const IG_MAX_COLLABORATORS = 3;
/** Instagram usernames: letters, numbers, periods and underscores, at most 30 characters. */
const IG_USERNAME = /^[a-z0-9._]{1,30}$/i;

/** "@Asha.Designs " -> "asha.designs". Instagram usernames are case-insensitive. */
export const normalizeUsername = (s: string) => s.trim().replace(/^@+/, "").toLowerCase();

/** The composer's free-text field ("@asha, ben_k") as a list of usernames, duplicates removed. */
export const parseCollaborators = (raw: string) => [...new Set(raw.split(/[\s,]+/).map(normalizeUsername).filter(Boolean))];

export const targetSchema = z.object({
  socialAccountId: z.uuid(),
  postAsVideo: z.boolean().default(false),
  contentOverride: z.string().max(5000).nullish(),
  /** Instagram only: usernames invited as collaborators. */
  collaborators: z
    .array(z.string().transform(normalizeUsername).pipe(z.string().regex(IG_USERNAME, "Instagram usernames use only letters, numbers, periods and underscores (30 at most).")))
    .max(IG_MAX_COLLABORATORS, `Instagram allows at most ${IG_MAX_COLLABORATORS} collaborators.`)
    .transform((list) => [...new Set(list)])
    .optional(),
});

export const postBodySchema = z.object({
  content: z.string().max(5000).default(""),
  targets: z.array(targetSchema).max(20).default([]),
  mediaIds: z.array(z.uuid()).max(10).default([]),
  mode: z.enum(["draft", "schedule", "now"]),
  scheduledAt: z.iso.datetime({ offset: true }).optional(),
});
export type PostBody = z.infer<typeof postBodySchema>;

export const rescheduleSchema = z.object({ scheduledAt: z.iso.datetime({ offset: true }) });

export const postListQuerySchema = z.object({
  status: z.string().optional(), // comma separated
  platform: z.string().optional(),
  q: z.string().max(200).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(20),
  order: z.enum(["asc", "desc"]).default("desc"),
});
export type PostListQuery = z.infer<typeof postListQuerySchema>;

export interface ValidationTarget {
  socialAccountId: string;
  platform: Platform;
  label: string; // e.g. "@asha on X (Twitter)"
  postAsVideo?: boolean;
  contentOverride?: string | null;
  collaborators?: string[];
}

export interface ValidationMedia {
  type: "image" | "video";
  sizeBytes?: number | null;
  /** GIFs have a larger limit on X than still images. */
  isGif?: boolean;
  width?: number | null;
  height?: number | null;
}

/** X rejects still images over 5 MB. Checking here tells the user before they hit "Schedule". */
export const X_IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;
/** Instagram reels (single-video posts). */
export const IG_REEL_LIMIT_BYTES = 300 * 1024 * 1024;
/** Instagram feed photos must be between 4:5 (portrait) and 1.91:1 (landscape). */
export const IG_MIN_RATIO = 4 / 5;
export const IG_MAX_RATIO = 1.91;
export const IG_MAX_HASHTAGS = 30;
export const LINKEDIN_VIDEO_LIMIT_BYTES = 500 * 1024 * 1024;

const MB = 1024 * 1024;
const countHashtags = (s: string) => (s.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;

export interface Issue {
  field: "content" | "targets" | "media" | "schedule" | "target";
  message: string;
  socialAccountId?: string;
}

/** Everything that must be true before a post may be scheduled or published. */
export function validateForPublish(input: {
  content: string;
  targets: ValidationTarget[];
  media: ValidationMedia[];
  mode: "schedule" | "now";
  scheduledAt?: Date | null;
  now?: Date;
}): Issue[] {
  const issues: Issue[] = [];
  const now = input.now ?? new Date();
  const images = input.media.filter((m) => m.type === "image").length;
  const videos = input.media.filter((m) => m.type === "video").length;

  if (input.targets.length === 0) issues.push({ field: "targets", message: "Pick at least one account to post to." });

  if (input.mode === "schedule") {
    if (!input.scheduledAt) {
      issues.push({ field: "schedule", message: "Choose a date and time." });
    } else {
      const lead = input.scheduledAt.getTime() - now.getTime();
      if (lead < MIN_LEAD_MS) issues.push({ field: "schedule", message: "Pick a time at least a minute in the future." });
      if (lead > MAX_LEAD_MS) issues.push({ field: "schedule", message: "Posts can be scheduled up to a year ahead." });
    }
  }

  for (const t of input.targets) {
    const meta = PLATFORM_META[t.platform];
    const text = t.contentOverride ?? input.content;
    const push = (message: string) => issues.push({ field: "target", message: `${t.label}: ${message}`, socialAccountId: t.socialAccountId });

    if (!meta.implemented) {
      push("this platform is not available yet.");
      continue;
    }
    const collaborators = t.collaborators ?? [];
    if (collaborators.length > 0) {
      if (t.platform !== "instagram") {
        push("collaborators are only available on Instagram.");
      } else {
        const bad = collaborators.filter((u) => !IG_USERNAME.test(normalizeUsername(u)));
        if (bad.length) push(`"${bad[0]}" is not a valid Instagram username.`);
        if (collaborators.length > IG_MAX_COLLABORATORS) push(`at most ${IG_MAX_COLLABORATORS} collaborators.`);
      }
    }
    if (countChars(t.platform, text) > meta.maxChars) {
      push(`over the ${meta.maxChars.toLocaleString()} character limit by ${(countChars(t.platform, text) - meta.maxChars).toLocaleString()}.`);
    }

    if (t.platform === "youtube") {
      if (videos !== 1) push("attach exactly one video to upload to YouTube.");
      if (!t.postAsVideo) push('turn on "Post as video" (YouTube cannot publish text-only posts).');
      if (!text.trim()) push("add a title on the first line.");
      continue;
    }

    if (meta.requiresMedia && images + videos === 0) push("add at least one photo or video (text-only posts are not possible).");
    if (!meta.requiresMedia && !text.trim() && images + videos === 0) push("add some text or media.");
    if (meta.requiresVideo && videos === 0) push("a video is required.");
    if (!meta.supportsVideo && videos > 0 && images === 0) push("video is not supported.");
    if (!meta.supportsImages && images > 0 && videos === 0) push("images are not supported.");
    if (images > meta.maxImages && meta.supportsImages) push(`at most ${meta.maxImages} images are allowed.`);
    if (t.platform === "twitter" && videos > 0 && images > 0) push("X allows images or a video, not both.");
    if (t.platform === "twitter" && videos > 1) push("X allows one video per post.");
    if (t.platform === "twitter" && input.media.some((m) => m.type === "image" && !m.isGif && (m.sizeBytes ?? 0) > X_IMAGE_LIMIT_BYTES)) {
      push("images must be 5 MB or smaller.");
    }

    if (t.platform === "instagram") {
      if (videos === 1 && images === 0 && input.media.some((m) => m.type === "video" && (m.sizeBytes ?? 0) > IG_REEL_LIMIT_BYTES)) {
        push(`reels must be ${IG_REEL_LIMIT_BYTES / MB} MB or smaller.`);
      }
      const offRatio = input.media.some((m) => {
        if (m.type !== "image" || !m.width || !m.height) return false;
        const r = m.width / m.height;
        return r < IG_MIN_RATIO - 0.01 || r > IG_MAX_RATIO + 0.01;
      });
      if (offRatio) push("photos must be between 4:5 (portrait) and 1.91:1 (landscape). Crop the photo and upload it again.");
      if (countHashtags(text) > IG_MAX_HASHTAGS) push(`at most ${IG_MAX_HASHTAGS} hashtags.`);
    }

    if (t.platform === "linkedin") {
      if (videos > 0 && images > 0) push("LinkedIn posts take photos or one video, not both.");
      if (videos > 1) push("one video per post.");
      if (input.media.some((m) => m.type === "video" && (m.sizeBytes ?? 0) > LINKEDIN_VIDEO_LIMIT_BYTES)) {
        push(`videos must be ${LINKEDIN_VIDEO_LIMIT_BYTES / MB} MB or smaller.`);
      }
    }
  }
  return issues;
}
