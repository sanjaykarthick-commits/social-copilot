export const PLATFORMS = [
  "twitter",
  "youtube",
  "linkedin",
  "instagram",
  "tiktok",
  "facebook",
  "threads",
  "pinterest",
  "bluesky",
] as const;
export type Platform = (typeof PLATFORMS)[number];

export const POST_STATUSES = ["draft", "scheduled", "publishing", "published", "failed"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const TARGET_STATUSES = ["pending", "publishing", "published", "failed"] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

export const ACCOUNT_STATUSES = ["connected", "expired", "revoked"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** One plan key everywhere. Never "pro". */
export const PLAN_KEYS = ["free", "premium"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export const AI_TONES = ["professional", "casual", "friendly", "witty"] as const;
export type AiTone = (typeof AI_TONES)[number];

export const TRIGGER_TYPES = ["keyword", "any_comment"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const REPLY_MODES = ["fixed", "ai"] as const;
export type ReplyMode = (typeof REPLY_MODES)[number];

export interface NotificationPrefs {
  postPublished: boolean;
  postFailed: boolean;
  weeklySummary: boolean;
  replySent: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  postPublished: true,
  postFailed: true,
  weeklySummary: false,
  replySent: false,
};
