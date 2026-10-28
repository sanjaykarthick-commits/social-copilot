import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  primaryKey,
  bigint,
} from "drizzle-orm/pg-core";
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from "@/lib/constants";

const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () =>
  ts("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * IDs: internal tables use uuid PKs. Clerk's id ("user_...") is NOT a uuid, so it
 * lives in users.clerk_id (text) and every foreign key points at users.id (uuid).
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  clerkId: text("clerk_id").notNull().unique(),
  email: text("email"),
  name: text("name"),
  imageUrl: text("image_url"),
  timezone: text("timezone").notNull().default("UTC"),
  aiTone: text("ai_tone").notNull().default("professional"),
  defaultPlatforms: text("default_platforms")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  notificationPrefs: jsonb("notification_prefs")
    .$type<NotificationPrefs>()
    .notNull()
    .default(DEFAULT_NOTIFICATION_PREFS),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "free" | "premium" */
    plan: text("plan").notNull().default("free"),
    /** active | canceled | past_due | ended | ... */
    status: text("status").notNull().default("active"),
    clerkSubscriptionId: text("clerk_subscription_id"),
    currentPeriodEnd: ts("current_period_end"),
    /** Timestamp of the newest Clerk billing event applied; older events are ignored. */
    lastEventAt: ts("last_event_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("subscriptions_user_id_idx").on(t.userId)],
);

/** One row per AI call: powers per-plan daily limits and burst rate limiting. */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** caption | reply | image */
    kind: text("kind").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("ai_usage_user_created_idx").on(t.userId, t.createdAt)],
);

export const socialAccounts = pgTable(
  "social_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    platformAccountId: text("platform_account_id").notNull(),
    username: text("username"),
    displayName: text("display_name"),
    profileImageUrl: text("profile_image_url"),
    /** AES-256-GCM encrypted (lib/crypto.ts). Never sent to the client. */
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    tokenExpiresAt: ts("token_expires_at"),
    scopes: text("scopes"),
    /** connected | expired | revoked */
    status: text("status").notNull().default("connected"),
    /** Cursor for the comment monitor: only look at comments newer than this. */
    lastCommentSyncAt: ts("last_comment_sync_at"),
    /** Cursor for the message monitor (Instagram DMs). */
    lastMessageSyncAt: ts("last_message_sync_at"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("social_accounts_user_platform_account_idx").on(t.userId, t.platform, t.platformAccountId),
    index("social_accounts_user_id_idx").on(t.userId),
  ],
);

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull().default(""),
    /** draft | scheduled | publishing | published | failed */
    status: text("status").notNull().default("draft"),
    scheduledAt: ts("scheduled_at"),
    publishedAt: ts("published_at"),
    /** Set when the post leaves draft (scheduled or post-now). Drives the monthly quota. */
    queuedAt: ts("queued_at"),
    failureReason: text("failure_reason"),
    inngestEventId: text("inngest_event_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("posts_user_status_idx").on(t.userId, t.status),
    index("posts_scheduled_at_idx").on(t.scheduledAt),
    index("posts_user_queued_idx").on(t.userId, t.queuedAt),
  ],
);

export const postTargets = pgTable(
  "post_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    /** pending | publishing | published | failed */
    status: text("status").notNull().default("pending"),
    platformPostId: text("platform_post_id"),
    platformPostUrl: text("platform_post_url"),
    error: text("error"),
    publishedAt: ts("published_at"),
    contentOverride: text("content_override"),
    /** YouTube: publish the attached video instead of a text-only post. */
    postAsVideo: boolean("post_as_video").notNull().default(false),
    /** Instagram: usernames invited as collaborators (up to 3). */
    collaborators: text("collaborators")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Adapter progress saved between retries (e.g. Instagram container id), so a retry never re-uploads or double-posts. */
    publishState: jsonb("publish_state").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("post_targets_post_id_idx").on(t.postId),
    uniqueIndex("post_targets_post_account_idx").on(t.postId, t.socialAccountId),
  ],
);

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    postId: uuid("post_id").references(() => posts.id, { onDelete: "set null" }),
    imagekitFileId: text("imagekit_file_id"),
    url: text("url").notNull(),
    thumbnailUrl: text("thumbnail_url"),
    /** image | video */
    type: text("type").notNull().default("image"),
    width: integer("width"),
    height: integer("height"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("media_assets_post_id_idx").on(t.postId), index("media_assets_user_id_idx").on(t.userId)],
);

export const replyRules = pgTable(
  "reply_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** keyword | any_comment */
    triggerType: text("trigger_type").notNull().default("keyword"),
    keywords: text("keywords")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    wholeWord: boolean("whole_word").notNull().default(false),
    /** fixed | ai */
    replyMode: text("reply_mode").notNull().default("fixed"),
    replyText: text("reply_text"),
    aiContextHint: text("ai_context_hint"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("reply_rules_user_enabled_idx").on(t.userId, t.enabled)],
);

export const replyRuleAccounts = pgTable(
  "reply_rule_accounts",
  {
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => replyRules.id, { onDelete: "cascade" }),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.ruleId, t.socialAccountId] })],
);

export const replyLogs = pgTable(
  "reply_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id").references(() => replyRules.id, { onDelete: "set null" }),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    platformCommentId: text("platform_comment_id").notNull(),
    commentText: text("comment_text").notNull(),
    replyText: text("reply_text"),
    /** sent | failed */
    status: text("status").notNull(),
    error: text("error"),
    createdAt: createdAt(),
  },
  // A comment is NEVER replied to twice.
  (t) => [uniqueIndex("reply_logs_account_comment_idx").on(t.socialAccountId, t.platformCommentId)],
);

export const postMetrics = pgTable(
  "post_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postTargetId: uuid("post_target_id")
      .notNull()
      .references(() => postTargets.id, { onDelete: "cascade" }),
    likes: integer("likes"),
    comments: integer("comments"),
    impressions: integer("impressions"),
    fetchedAt: ts("fetched_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("post_metrics_target_idx").on(t.postTargetId)],
);

/** Comments people left on the user's posts (the inbox). Synced from the platforms. */
export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    platformCommentId: text("platform_comment_id").notNull(),
    platformPostId: text("platform_post_id").notNull(),
    /** Set when the comment is on a post published through Social Copilot. */
    postTargetId: uuid("post_target_id").references(() => postTargets.id, { onDelete: "set null" }),
    postUrl: text("post_url"),
    postTitle: text("post_title"),
    postThumbnailUrl: text("post_thumbnail_url"),
    authorName: text("author_name"),
    authorHandle: text("author_handle"),
    authorImageUrl: text("author_image_url"),
    text: text("text").notNull().default(""),
    likeCount: integer("like_count"),
    commentedAt: ts("commented_at").notNull(),
    /** open (needs a reply) | replied | archived */
    status: text("status").notNull().default("open"),
    repliedAt: ts("replied_at"),
    /** Platform data needed to reply (e.g. LinkedIn's thread URN). */
    extra: jsonb("extra").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("comments_account_comment_idx").on(t.socialAccountId, t.platformCommentId),
    index("comments_user_status_idx").on(t.userId, t.status, t.commentedAt),
  ],
);

export const commentReplies = pgTable(
  "comment_replies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    commentId: uuid("comment_id")
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    /** sending | sent | failed */
    status: text("status").notNull().default("sending"),
    platformReplyId: text("platform_reply_id"),
    error: text("error"),
    /** Sent by the browser per reply attempt: a double click or a retried request never replies twice. */
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("comment_replies_idempotency_idx").on(t.userId, t.idempotencyKey), index("comment_replies_comment_idx").on(t.commentId)],
);

/** Direct-message conversations (Instagram DMs), one per person per connected account. Synced by polling. */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    platformConversationId: text("platform_conversation_id").notNull(),
    /** The other person's platform-scoped id: replies are addressed to it. */
    participantId: text("participant_id").notNull(),
    participantHandle: text("participant_handle"),
    participantName: text("participant_name"),
    participantImageUrl: text("participant_image_url"),
    lastMessageText: text("last_message_text"),
    lastMessageAt: ts("last_message_at"),
    lastMessageFromMe: boolean("last_message_from_me").notNull().default(false),
    /** The other person's latest message. Instagram allows replies until 24 hours after it. */
    lastInboundAt: ts("last_inbound_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("conversations_account_conversation_idx").on(t.socialAccountId, t.platformConversationId),
    index("conversations_user_last_idx").on(t.userId, t.lastMessageAt),
  ],
);

export const directMessages = pgTable(
  "direct_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Null until the platform confirms a message we send. */
    platformMessageId: text("platform_message_id"),
    /** inbound (from them) | outbound (from the account owner) */
    direction: text("direction").notNull(),
    text: text("text").notNull().default(""),
    sentAt: ts("sent_at").notNull(),
    /** received | sending | sent | failed */
    status: text("status").notNull(),
    error: text("error"),
    /** Sent by the browser per send attempt (outbound only): a double click or a retried request never sends twice. */
    idempotencyKey: text("idempotency_key"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("direct_messages_conversation_message_idx").on(t.conversationId, t.platformMessageId),
    uniqueIndex("direct_messages_idempotency_idx").on(t.userId, t.idempotencyKey),
    index("direct_messages_conversation_sent_idx").on(t.conversationId, t.sentAt),
  ],
);

export type DbUser = typeof users.$inferSelect;
export type DbSubscription = typeof subscriptions.$inferSelect;
export type SocialAccount = typeof socialAccounts.$inferSelect;
export type Post = typeof posts.$inferSelect;
export type PostTarget = typeof postTargets.$inferSelect;
export type MediaAsset = typeof mediaAssets.$inferSelect;
export type ReplyRule = typeof replyRules.$inferSelect;
export type ReplyLog = typeof replyLogs.$inferSelect;
export type PostMetric = typeof postMetrics.$inferSelect;
export type DbComment = typeof comments.$inferSelect;
export type CommentReply = typeof commentReplies.$inferSelect;
export type DbConversation = typeof conversations.$inferSelect;
export type DirectMessage = typeof directMessages.$inferSelect;
