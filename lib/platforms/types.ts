import type { Platform } from "@/lib/constants";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  scopes?: string | null;
}

export interface AccountProfile {
  platformAccountId: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  metadata?: Record<string, unknown>;
}

/** A social account with tokens already decrypted. Server-side only; never serialize to the client. */
export interface AdapterAccount {
  id: string;
  platform: Platform;
  platformAccountId: string;
  username: string | null;
  displayName: string | null;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  scopes: string | null;
  metadata: Record<string, unknown>;
}

export interface PublishMedia {
  url: string;
  type: "image" | "video";
  mimeType?: string | null;
  sizeBytes?: number | null;
}

export interface PublishInput {
  account: AdapterAccount;
  content: string;
  media: PublishMedia[];
  /** YouTube: publish the attached video. */
  asVideo?: boolean;
  /** Instagram: usernames invited as collaborators (they must accept before the post shows on their profile). */
  collaborators?: string[];
  /**
   * Progress saved by an earlier attempt of this same target (e.g. an Instagram container id),
   * so a retried step resumes instead of uploading again or publishing twice.
   */
  state?: Record<string, unknown> | null;
  /** Persist progress before a slow or non-idempotent step. */
  saveState?: (state: Record<string, unknown>) => Promise<void>;
}

export interface PublishResult {
  platformPostId: string;
  url?: string;
}

/**
 * auth        token expired / revoked: the user must reconnect (not retryable)
 * rate_limit  platform throttled us (retryable later)
 * validation  the post itself is not acceptable (not retryable)
 * api         platform rejected the call (message is shown to the user)
 * config      the integration is not configured on this server
 */
export type PlatformErrorKind = "auth" | "rate_limit" | "validation" | "api" | "config";

export class PlatformError extends Error {
  constructor(
    message: string,
    public kind: PlatformErrorKind,
    public retryable = false,
    public status?: number,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

/** null means "the platform did not report it" (never a made-up zero). */
export interface PostMetrics {
  likes: number | null;
  comments: number | null;
  /** Impressions on X, views on YouTube. */
  impressions: number | null;
}

/** A comment someone left on one of the account's posts. */
export interface PlatformComment {
  platformCommentId: string;
  platformPostId: string;
  /** Where the post lives, and what to call it in the inbox (video title, caption excerpt). */
  postUrl: string | null;
  postTitle: string | null;
  postThumbnailUrl: string | null;
  authorName: string | null;
  authorHandle: string | null;
  authorImageUrl: string | null;
  text: string;
  likeCount: number | null;
  createdAt: Date;
  /** The account owner already answered it (on the platform or through us). */
  ownerReplied: boolean;
  /** Platform-specific data needed to reply later (e.g. LinkedIn's thread object URN). */
  extra?: Record<string, unknown>;
}

export interface FetchCommentsArgs {
  /** Posts published through Social Copilot for this account (platform ids), newest first. */
  knownPostIds: string[];
  /** Only comments newer than this are needed (older ones are already stored). */
  since: Date;
}

/** What this connection can do, given the permissions the user (and the platform) granted. */
export interface AccountCapabilities {
  metrics: boolean;
  comments: boolean;
  /** Plain-language reason when something is unavailable. */
  note?: string;
}

export interface PlatformAdapter {
  platform: Platform;
  implemented: boolean;
  getAuthUrl(args: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(args: { code: string; codeVerifier: string; redirectUri: string }): Promise<TokenSet & AccountProfile>;
  refreshToken(account: AdapterAccount): Promise<TokenSet>;
  /**
   * Refresh this long before expiry. Instagram tokens live 60 days and can only be
   * refreshed while still valid, so they are renewed weeks ahead. Default: 5 minutes.
   */
  refreshWindowMs?: number;
  /** False when the platform gives us no way to renew the token (the user must reconnect). */
  canRefresh?(account: Pick<AdapterAccount, "refreshToken">): boolean;
  /** Best effort; failures are ignored by the caller. */
  revokeToken?(account: AdapterAccount): Promise<void>;
  publish(input: PublishInput): Promise<PublishResult>;
  /** Engagement for already-published posts, keyed by platform post id. Absent when the platform offers none. */
  fetchMetrics?(account: AdapterAccount, platformPostIds: string[]): Promise<Map<string, PostMetrics>>;
  fetchComments?(account: AdapterAccount, args: FetchCommentsArgs): Promise<PlatformComment[]>;
  replyToComment?(account: AdapterAccount, comment: { platformCommentId: string; platformPostId: string; extra?: Record<string, unknown> }, text: string): Promise<{ platformReplyId: string }>;
  capabilities?(account: Pick<AdapterAccount, "scopes">): AccountCapabilities;
}
