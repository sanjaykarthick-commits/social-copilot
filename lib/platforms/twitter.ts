import { requireEnv } from "@/lib/env";
import { errorFromResponse, extractMessage, readBody, safeFetch } from "@/lib/platforms/http";
import { mediaSize, mimeFor, readSlice } from "@/lib/platforms/media-io";
import {
  PlatformError,
  type AccountProfile,
  type AdapterAccount,
  type PlatformAdapter,
  type PublishInput,
  type PublishMedia,
  type PostMetrics,
  type PublishResult,
  type TokenSet,
} from "@/lib/platforms/types";

/**
 * X (Twitter) adapter, OAuth 2.0 Authorization Code + PKCE.
 * Endpoints verified against docs.x.com:
 *   authorize  https://x.com/i/oauth2/authorize
 *   token      https://api.x.com/2/oauth2/token     (confidential client: HTTP Basic)
 *   me         GET  https://api.x.com/2/users/me
 *   post       POST https://api.x.com/2/tweets      -> 201 { data: { id, text } }
 *   media      POST /2/media/upload/initialize (JSON) -> /{id}/append (multipart) -> /{id}/finalize
 */
const AUTH_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const REVOKE_URL = "https://api.x.com/2/oauth2/revoke";
const API = "https://api.x.com/2";

/** offline.access -> refresh token. media.write -> upload images / video. */
export const TWITTER_SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"];

const CHUNK_BYTES = 4 * 1024 * 1024; // X: <= 5 MB per segment (hard max 8 MB)
const IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;

function basicAuth(): string {
  const { TWITTER_CLIENT_ID, TWITTER_CLIENT_SECRET } = requireEnv("TWITTER_CLIENT_ID", "TWITTER_CLIENT_SECRET");
  return `Basic ${Buffer.from(`${TWITTER_CLIENT_ID}:${TWITTER_CLIENT_SECRET}`).toString("base64")}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

async function tokenRequest(params: Record<string, string>, context: string): Promise<TokenSet> {
  const res = await safeFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth() },
    body: new URLSearchParams(params).toString(),
  });
  const body = await readBody(res);
  if (!res.ok) {
    const err = errorFromResponse(res, body, context);
    // invalid_grant on refresh/exchange means the user must reconnect.
    if (res.status === 400 && /invalid_(grant|request)/i.test(JSON.stringify(body))) {
      throw new PlatformError(`${context}: ${extractMessage(body, "invalid grant")}. Reconnect the account.`, "auth", false, 400);
    }
    throw err;
  }
  const t = body as TokenResponse;
  if (!t?.access_token) throw new PlatformError(`${context}: X returned no access token.`, "api", false);
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null,
    scopes: t.scope ?? null,
  };
}

async function fetchMe(accessToken: string): Promise<AccountProfile> {
  const res = await safeFetch(`${API}/users/me?user.fields=profile_image_url,username,name`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await readBody(res);
  if (!res.ok) throw errorFromResponse(res, body, "Fetching your X profile");
  const u = (body as { data?: { id: string; username?: string; name?: string; profile_image_url?: string } }).data;
  if (!u?.id) throw new PlatformError("X did not return a user id.", "api", false);
  return {
    platformAccountId: u.id,
    username: u.username ?? null,
    displayName: u.name ?? null,
    // `_normal` is a 48px thumbnail; the 400x400 variant looks right in previews.
    profileImageUrl: u.profile_image_url?.replace("_normal", "_400x400") ?? null,
  };
}

async function xJson(res: Response, context: string): Promise<Record<string, unknown>> {
  const body = await readBody(res);
  if (!res.ok) throw errorFromResponse(res, body, context);
  return (body ?? {}) as Record<string, unknown>;
}

async function uploadMedia(accessToken: string, m: PublishMedia): Promise<string> {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const mime = mimeFor(m);
  const total = await mediaSize(m);
  const isGif = mime === "image/gif";
  if (m.type === "image" && total > IMAGE_LIMIT_BYTES && !isGif) {
    throw new PlatformError("X images must be 5 MB or smaller.", "validation", false);
  }
  const category = m.type === "video" ? "tweet_video" : isGif ? "tweet_gif" : "tweet_image";

  const init = await xJson(
    await safeFetch(`${API}/media/upload/initialize`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ media_type: mime, total_bytes: total, media_category: category }),
    }),
    "Starting X media upload",
  );
  const mediaId = (init.data as { id?: string } | undefined)?.id;
  if (!mediaId) throw new PlatformError("X did not return a media id.", "api", false);

  for (let index = 0, offset = 0; offset < total; index += 1, offset += CHUNK_BYTES) {
    const chunk = await readSlice(m.url, offset, Math.min(offset + CHUNK_BYTES, total) - 1);
    const form = new FormData();
    form.set("segment_index", String(index));
    form.set("media", new Blob([chunk], { type: mime }), "chunk");
    const res = await safeFetch(`${API}/media/upload/${mediaId}/append`, {
      method: "POST",
      headers: auth, // let fetch set the multipart boundary
      body: form,
      timeoutMs: 120_000,
    });
    if (!res.ok) throw errorFromResponse(res, await readBody(res), "Uploading media to X");
  }

  const fin = await xJson(
    await safeFetch(`${API}/media/upload/${mediaId}/finalize`, { method: "POST", headers: auth }),
    "Finishing X media upload",
  );
  let info = (fin.data as { processing_info?: { state: string; check_after_secs?: number; error?: { message?: string } } } | undefined)
    ?.processing_info;

  // Video is processed asynchronously. Poll for up to ~50s; otherwise retry the step later.
  const deadline = Date.now() + 50_000;
  while (info && info.state !== "succeeded") {
    if (info.state === "failed") {
      throw new PlatformError(`X could not process the media: ${info.error?.message ?? "unknown error"}.`, "validation", false);
    }
    if (Date.now() > deadline) throw new PlatformError("X is still processing the video; will retry.", "api", true);
    await new Promise((r) => setTimeout(r, Math.min(Math.max((info!.check_after_secs ?? 3) * 1000, 1000), 10_000)));
    const status = await xJson(
      await safeFetch(`${API}/media/upload?command=STATUS&media_id=${mediaId}`, { headers: auth }),
      "Checking X media status",
    );
    info = (status.data as { processing_info?: typeof info } | undefined)?.processing_info;
  }
  return mediaId;
}

export const twitterAdapter: PlatformAdapter = {
  platform: "twitter",
  implemented: true,

  getAuthUrl({ state, codeChallenge, redirectUri }) {
    const { TWITTER_CLIENT_ID } = requireEnv("TWITTER_CLIENT_ID", "TWITTER_CLIENT_SECRET");
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: TWITTER_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: TWITTER_SCOPES.join(" "),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  },

  async exchangeCode({ code, codeVerifier, redirectUri }) {
    const { TWITTER_CLIENT_ID } = requireEnv("TWITTER_CLIENT_ID", "TWITTER_CLIENT_SECRET");
    const tokens = await tokenRequest(
      { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier, client_id: TWITTER_CLIENT_ID },
      "Exchanging the X authorization code",
    );
    const profile = await fetchMe(tokens.accessToken); // real username, name and avatar
    return { ...tokens, ...profile };
  },

  async refreshToken(account: AdapterAccount) {
    if (!account.refreshToken) throw new PlatformError("No refresh token stored. Reconnect the account.", "auth", false);
    // X rotates refresh tokens: the new one MUST be stored by the caller.
    return tokenRequest({ grant_type: "refresh_token", refresh_token: account.refreshToken }, "Refreshing the X token");
  },

  async revokeToken(account: AdapterAccount) {
    const { TWITTER_CLIENT_ID } = requireEnv("TWITTER_CLIENT_ID", "TWITTER_CLIENT_SECRET");
    await safeFetch(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth() },
      body: new URLSearchParams({ token: account.accessToken, token_type_hint: "access_token", client_id: TWITTER_CLIENT_ID }).toString(),
    });
  },

  async fetchMetrics(account: AdapterAccount, ids: string[]) {
    const out = new Map<string, PostMetrics>();
    for (let i = 0; i < ids.length; i += 100) {
      // docs.x.com: GET /2/tweets?ids=<=100&post.fields=public_metrics (needs tweet.read)
      const res = await safeFetch(`${API}/tweets?ids=${ids.slice(i, i + 100).join(",")}&post.fields=public_metrics`, {
        headers: { Authorization: `Bearer ${account.accessToken}` },
      });
      const body = await readBody(res);
      if (!res.ok) throw errorFromResponse(res, body, "Reading X post metrics");
      type Item = { id: string; public_metrics?: { like_count?: number; reply_count?: number; impression_count?: number } };
      for (const t of (body as { data?: Item[] }).data ?? []) {
        const m = t.public_metrics;
        out.set(t.id, { likes: m?.like_count ?? null, comments: m?.reply_count ?? null, impressions: m?.impression_count ?? null });
      }
    }
    return out;
  },

  async publish({ account, content, media }: PublishInput): Promise<PublishResult> {
    const images = media.filter((m) => m.type === "image");
    const videos = media.filter((m) => m.type === "video");
    if (videos.length > 1 || (videos.length === 1 && images.length > 0)) {
      throw new PlatformError("X allows up to 4 images or 1 video per post, not both.", "validation", false);
    }
    if (images.length > 4) throw new PlatformError("X allows at most 4 images per post.", "validation", false);
    if (!content.trim() && media.length === 0) throw new PlatformError("A post needs text or media.", "validation", false);

    const mediaIds: string[] = [];
    for (const m of [...images, ...videos]) mediaIds.push(await uploadMedia(account.accessToken, m));

    const res = await safeFetch(`${API}/tweets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${account.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: content, ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}) }),
    });
    const body = await readBody(res);
    if (!res.ok) {
      const err = errorFromResponse(res, body, "Posting to X");
      // Plan / credit problems come back as 402/403 with a clear message; surface it.
      if (res.status === 403 && /duplicate/i.test(err.message)) err.message = "X rejected this as a duplicate post. Change the text and try again.";
      throw err;
    }
    const id = (body as { data?: { id?: string } })?.data?.id;
    if (!id) throw new PlatformError("X accepted the post but returned no id.", "api", false);
    return { platformPostId: id, url: `https://x.com/${account.username ?? "i"}/status/${id}` };
  },
};
