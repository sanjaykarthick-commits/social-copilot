import { getEnv, requireEnv } from "@/lib/env";
import { errorFromResponse, extractMessage, readBody, safeFetch } from "@/lib/platforms/http";
import { mediaSize, mimeFor, readAll, readSlice, withTransform } from "@/lib/platforms/media-io";
import {
  PlatformError,
  type AccountProfile,
  type AdapterAccount,
  type PlatformAdapter,
  type PlatformComment,
  type PostMetrics,
  type PublishInput,
  type PublishMedia,
  type PublishResult,
  type TokenSet,
} from "@/lib/platforms/types";

/**
 * LinkedIn adapter for a member's own profile, using only self-serve products:
 *   "Sign In with LinkedIn using OpenID Connect" (openid, profile) and "Share on LinkedIn" (w_member_social).
 * Verified against learn.microsoft.com/linkedin (versioned API, li-lms-2026-10):
 *   authorize   https://www.linkedin.com/oauth/v2/authorization
 *   token       POST https://www.linkedin.com/oauth/v2/accessToken   (60-day tokens; refresh tokens only for approved partners)
 *   profile     GET  https://api.linkedin.com/v2/userinfo            (sub -> urn:li:person:{sub})
 *   post        POST /rest/posts                                     -> 201, id in the x-restli-id header
 *   images      POST /rest/images?action=initializeUpload, then PUT the bytes
 *   videos      POST /rest/videos?action=initializeUpload, PUT each part (ETag), POST ?action=finalizeUpload
 *
 * Reading comments needs r_member_social and post statistics need r_member_postAnalytics. LinkedIn grants
 * those only to approved apps (Community Management API), so they are requested only when listed in
 * LINKEDIN_EXTRA_SCOPES, and the features switch on per account when the token actually carries them.
 */
const AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const REST = "https://api.linkedin.com/rest";

export const LINKEDIN_DEFAULT_VERSION = "202610";
export const LINKEDIN_BASE_SCOPES = ["openid", "profile", "w_member_social"];
export const LINKEDIN_VIDEO_MAX_BYTES = 500 * 1024 * 1024;
const VIDEO_WAIT_MS = 120_000;

export function linkedinScopes(): string[] {
  const extra = (getEnv().LINKEDIN_EXTRA_SCOPES ?? "").split(/[\s,]+/).filter((s) => /^[A-Za-z_]+$/.test(s));
  return [...new Set([...LINKEDIN_BASE_SCOPES, ...extra])];
}

const hasScope = (scopes: string | null | undefined, scope: string) => (scopes ?? "").split(/[\s,]+/).includes(scope);

/**
 * Commentary uses LinkedIn's "little" text format: every reserved character must be escaped with a
 * backslash or the post can be cut short. A `#` that starts a word is left alone so hashtags still work.
 */
export function toLittleText(text: string): string {
  return text.replace(/[|{}@[\]()<>#\\*_~]/g, (ch, offset: number, s: string) => {
    if (ch === "#" && (offset === 0 || /\s/.test(s[offset - 1])) && /[\p{L}\p{N}]/u.test(s[offset + 1] ?? "")) return ch;
    return `\\${ch}`;
  });
}

function apiVersion() {
  return getEnv().LINKEDIN_API_VERSION ?? LINKEDIN_DEFAULT_VERSION;
}

function restHeaders(token: string, extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${token}`,
    "LinkedIn-Version": apiVersion(),
    "X-Restli-Protocol-Version": "2.0.0",
    ...extra,
  };
}

async function rest<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}, context: string): Promise<{ body: T; res: Response }> {
  const res = await safeFetch(`${REST}${path}`, {
    method: init.method ?? "GET",
    headers: restHeaders(token, init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = await readBody(res);
  if (!res.ok) throw errorFromResponse(res, body, context);
  return { body: (body ?? {}) as T, res };
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

async function tokenRequest(params: Record<string, string>, context: string): Promise<TokenSet> {
  const { LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET } = requireEnv("LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET");
  const res = await safeFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: LINKEDIN_CLIENT_ID, client_secret: LINKEDIN_CLIENT_SECRET }).toString(),
  });
  const body = await readBody(res);
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) {
      throw new PlatformError(`${context}: ${extractMessage(body, "the authorization was rejected")}. Reconnect LinkedIn.`, "auth", false, res.status);
    }
    throw errorFromResponse(res, body, context);
  }
  const t = body as TokenResponse;
  if (!t?.access_token) throw new PlatformError(`${context}: LinkedIn returned no access token.`, "api", false);
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (t.expires_in ?? 60 * 86_400) * 1000),
    scopes: t.scope ?? null,
  };
}

async function fetchProfile(token: string): Promise<AccountProfile> {
  const res = await safeFetch(USERINFO_URL, { headers: { Authorization: `Bearer ${token}` } });
  const body = await readBody(res);
  if (!res.ok) throw errorFromResponse(res, body, "Fetching your LinkedIn profile");
  const u = body as { sub?: string; name?: string; given_name?: string; family_name?: string; picture?: string };
  if (!u?.sub) throw new PlatformError("LinkedIn did not return a member id.", "api", false);
  return {
    platformAccountId: u.sub,
    // LinkedIn does not expose the public profile handle to apps; show the member's name instead.
    username: null,
    displayName: u.name ?? ([u.given_name, u.family_name].filter(Boolean).join(" ") || null),
    profileImageUrl: u.picture ?? null,
  };
}

const personUrn = (account: Pick<AdapterAccount, "platformAccountId">) => `urn:li:person:${account.platformAccountId}`;

const LINKEDIN_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif"]);

async function uploadImage(token: string, owner: string, m: PublishMedia): Promise<string> {
  const init = await rest<{ value?: { uploadUrl?: string; image?: string } }>(
    token,
    "/images?action=initializeUpload",
    { method: "POST", body: { initializeUploadRequest: { owner } } },
    "Starting the LinkedIn image upload",
  );
  const { uploadUrl, image } = init.body.value ?? {};
  if (!uploadUrl || !image) throw new PlatformError("LinkedIn did not return an image upload URL.", "api", false);
  // LinkedIn takes JPG, PNG and GIF; anything else (e.g. WebP) is converted by ImageKit first.
  const bytes = await readAll(LINKEDIN_IMAGE_TYPES.has(mimeFor(m)) ? m.url : withTransform(m.url, "f-jpg"));
  const res = await safeFetch(uploadUrl, { method: "PUT", headers: { Authorization: `Bearer ${token}` }, body: bytes, timeoutMs: 120_000 });
  if (!res.ok) throw errorFromResponse(res, await readBody(res), "Uploading the image to LinkedIn");
  return image;
}

type Instruction = { uploadUrl: string; firstByte: number; lastByte: number };

async function uploadVideo(token: string, owner: string, m: PublishMedia): Promise<string> {
  const size = await mediaSize(m);
  if (size > LINKEDIN_VIDEO_MAX_BYTES) throw new PlatformError("LinkedIn videos must be 500 MB or smaller.", "validation", false);
  const init = await rest<{ value?: { video?: string; uploadToken?: string; uploadInstructions?: Instruction[] } }>(
    token,
    "/videos?action=initializeUpload",
    { method: "POST", body: { initializeUploadRequest: { owner, fileSizeBytes: size, uploadCaptions: false, uploadThumbnail: false } } },
    "Starting the LinkedIn video upload",
  );
  const { video, uploadToken = "", uploadInstructions = [] } = init.body.value ?? {};
  if (!video || uploadInstructions.length === 0) throw new PlatformError("LinkedIn did not return video upload instructions.", "api", false);

  const etags: string[] = [];
  for (const part of uploadInstructions) {
    const chunk = await readSlice(m.url, part.firstByte, part.lastByte);
    const res = await safeFetch(part.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: chunk, timeoutMs: 180_000 });
    if (!res.ok) throw errorFromResponse(res, await readBody(res), "Uploading the video to LinkedIn");
    const etag = res.headers.get("etag");
    if (!etag) throw new PlatformError("LinkedIn did not acknowledge a video part (no ETag).", "api", true);
    etags.push(etag);
  }
  await rest(token, "/videos?action=finalizeUpload", { method: "POST", body: { finalizeUploadRequest: { video, uploadToken, uploadedPartIds: etags } } }, "Finishing the LinkedIn video upload");
  return video;
}

/** Wait for LinkedIn to process the video. Tokens with only w_member_social may not be allowed to read it (403): then just proceed. */
async function waitForVideo(token: string, urn: string): Promise<void> {
  const deadline = Date.now() + VIDEO_WAIT_MS;
  for (let attempt = 0; ; attempt += 1) {
    const res = await safeFetch(`${REST}/videos/${encodeURIComponent(urn)}`, { headers: restHeaders(token) });
    if (res.status === 403) return;
    const body = (await readBody(res)) as { status?: string; processingFailureReason?: string } | undefined;
    if (!res.ok) throw errorFromResponse(res, body, "Checking the LinkedIn video");
    if (body?.status === "AVAILABLE") return;
    if (body?.status === "PROCESSING_FAILED") {
      throw new PlatformError(`LinkedIn could not process the video${body.processingFailureReason ? `: ${body.processingFailureReason}` : ""}. Use an MP4 between 3 seconds and 30 minutes.`, "validation", false);
    }
    if (Date.now() > deadline) throw new PlatformError("LinkedIn is still processing the video; will check again shortly.", "api", true);
    await new Promise((r) => setTimeout(r, Math.min(2000 * 2 ** attempt, 15_000)));
  }
}

async function publish({ account, content, media, state, saveState }: PublishInput): Promise<PublishResult> {
  const token = account.accessToken;
  const author = personUrn(account);
  const images = media.filter((m) => m.type === "image");
  const videos = media.filter((m) => m.type === "video");
  if (videos.length > 0 && images.length > 0) throw new PlatformError("LinkedIn posts take photos or one video, not both.", "validation", false);
  if (videos.length > 1) throw new PlatformError("LinkedIn allows one video per post.", "validation", false);
  if (images.length > 20) throw new PlatformError("LinkedIn allows at most 20 photos per post.", "validation", false);
  if (!content.trim() && media.length === 0) throw new PlatformError("A LinkedIn post needs text or media.", "validation", false);

  // Uploads are expensive and their URNs stay valid, so a retried attempt reuses them.
  let assets = Array.isArray(state?.assets) && state.assets.length === media.length ? (state.assets as string[]) : undefined;
  if (!assets && media.length > 0) {
    assets = [];
    for (const m of [...images, ...videos]) assets.push(m.type === "video" ? await uploadVideo(token, author, m) : await uploadImage(token, author, m));
    await saveState?.({ assets });
  }
  if (videos.length === 1 && assets) await waitForVideo(token, assets[0]);

  const contentField =
    !assets || assets.length === 0
      ? {}
      : assets.length === 1
        ? { content: { media: { id: assets[0] } } }
        : { content: { multiImage: { images: assets.map((id) => ({ id })) } } };

  let res: Response;
  try {
    res = await fetch(`${REST}/posts`, {
      method: "POST",
      headers: restHeaders(token, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        author,
        commentary: toLittleText(content),
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        ...contentField,
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    // The request may have reached LinkedIn. Retrying could post twice, so stop and let the user check.
    const reason = e instanceof Error ? e.message : String(e);
    throw new PlatformError(`LinkedIn did not confirm the post (${reason}). Check your profile before retrying.`, "api", false);
  }
  const body = await readBody(res);
  if (!res.ok) {
    const err = errorFromResponse(res, body, "Posting to LinkedIn");
    if (res.status === 422 && /duplicate/i.test(err.message)) err.message = "LinkedIn rejected this as a duplicate of a recent post. Change the text and try again.";
    throw err;
  }
  const id = res.headers.get("x-restli-id") ?? (body as { id?: string } | undefined)?.id;
  if (!id) throw new PlatformError("LinkedIn accepted the post but returned no id.", "api", false);
  return { platformPostId: id, url: `https://www.linkedin.com/feed/update/${id}/` };
}

const METRIC_TYPES = ["IMPRESSION", "REACTION", "COMMENT"] as const;

async function postMetric(token: string, urn: string, type: (typeof METRIC_TYPES)[number]): Promise<number | null> {
  const kind = urn.startsWith("urn:li:ugcPost:") ? "ugc" : "share";
  // Rest.li 2.0 query syntax: the URN is encoded, the (key:value) structure is not.
  const path = `/memberCreatorPostAnalytics?q=entity&entity=(${kind}:${encodeURIComponent(urn)})&queryType=${type}&aggregation=TOTAL`;
  const { body } = await rest<{ elements?: { count?: number }[] }>(token, path, {}, "Reading LinkedIn post statistics");
  const count = body.elements?.[0]?.count;
  return typeof count === "number" ? count : null;
}

export const linkedinAdapter: PlatformAdapter = {
  platform: "linkedin",
  implemented: true,
  canRefresh: (account) => Boolean(account.refreshToken),

  getAuthUrl({ state, redirectUri }) {
    const { LINKEDIN_CLIENT_ID } = requireEnv("LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET");
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: LINKEDIN_CLIENT_ID,
      redirect_uri: redirectUri,
      state,
      scope: linkedinScopes().join(" "),
    }).toString();
    return url.toString();
  },

  async exchangeCode({ code, redirectUri }) {
    const tokens = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri }, "Exchanging the LinkedIn authorization code");
    return { ...tokens, ...(await fetchProfile(tokens.accessToken)) };
  },

  async refreshToken(account: AdapterAccount) {
    if (!account.refreshToken) {
      throw new PlatformError("LinkedIn connections last 60 days and LinkedIn does not let apps renew them. Reconnect LinkedIn.", "auth", false);
    }
    return tokenRequest({ grant_type: "refresh_token", refresh_token: account.refreshToken }, "Refreshing the LinkedIn token");
  },

  capabilities(account) {
    const metrics = hasScope(account.scopes, "r_member_postAnalytics");
    const comments = hasScope(account.scopes, "r_member_social") || hasScope(account.scopes, "r_member_social_feed");
    return {
      metrics,
      comments,
      note:
        metrics && comments
          ? undefined
          : "LinkedIn only shares post stats and comments with apps it has approved (Community Management API). Publishing works without it.",
    };
  },

  publish,

  async fetchMetrics(account: AdapterAccount, ids: string[]) {
    const out = new Map<string, PostMetrics>();
    if (!hasScope(account.scopes, "r_member_postAnalytics")) return out;
    for (const urn of ids) {
      const [impressions, likes, comments] = await Promise.all(METRIC_TYPES.map((t) => postMetric(account.accessToken, urn, t)));
      out.set(urn, { likes, comments, impressions });
    }
    return out;
  },

  async fetchComments(account, { knownPostIds, since }) {
    const caps = linkedinAdapter.capabilities!(account);
    if (!caps.comments) return [];
    const me = personUrn(account);
    const out: PlatformComment[] = [];
    for (const urn of knownPostIds.slice(0, 20)) {
      type LiComment = { id?: string; commentUrn?: string; actor?: string; object?: string; created?: { time?: number }; message?: { text?: string }; likesSummary?: { totalLikes?: number } };
      const { body } = await rest<{ elements?: LiComment[] }>(account.accessToken, `/socialActions/${encodeURIComponent(urn)}/comments?count=50`, {}, "Reading LinkedIn comments");
      for (const c of body.elements ?? []) {
        if (!c.commentUrn || c.actor === me) continue;
        const createdAt = new Date(c.created?.time ?? Date.now());
        if (createdAt < since) continue;
        out.push({
          platformCommentId: c.commentUrn,
          platformPostId: urn,
          postUrl: `https://www.linkedin.com/feed/update/${urn}/`,
          postTitle: null,
          postThumbnailUrl: null,
          authorName: null, // other members' names are not available to apps
          authorHandle: null,
          authorImageUrl: null,
          text: c.message?.text ?? "",
          likeCount: c.likesSummary?.totalLikes ?? null,
          createdAt,
          ownerReplied: false,
          extra: { object: c.object ?? urn },
        });
      }
    }
    return out;
  },

  async replyToComment(account, comment, text) {
    const { body, res } = await rest<{ commentUrn?: string; id?: string }>(
      account.accessToken,
      `/socialActions/${encodeURIComponent(comment.platformCommentId)}/comments`,
      {
        method: "POST",
        body: {
          actor: personUrn(account),
          object: (comment.extra?.object as string | undefined) ?? comment.platformPostId,
          message: { text },
          parentComment: comment.platformCommentId,
        },
      },
      "Replying on LinkedIn",
    );
    const id = body.commentUrn ?? res.headers.get("x-restli-id") ?? body.id;
    if (!id) throw new PlatformError("LinkedIn accepted the reply but returned no id.", "api", false);
    return { platformReplyId: id };
  },
};
