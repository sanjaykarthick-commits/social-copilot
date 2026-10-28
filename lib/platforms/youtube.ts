import { requireEnv } from "@/lib/env";
import { errorFromResponse, extractMessage, readBody, safeFetch } from "@/lib/platforms/http";
import { youtubeTitle } from "@/lib/platforms/length";
import { mediaSize, mimeFor, readSlice } from "@/lib/platforms/media-io";
import {
  PlatformError,
  type AccountProfile,
  type AdapterAccount,
  type PlatformAdapter,
  type PostMetrics,
  type PublishInput,
  type PublishResult,
  type TokenSet,
} from "@/lib/platforms/types";

/**
 * YouTube adapter: Google OAuth 2.0 (Authorization Code + PKCE, offline access)
 * and the YouTube Data API v3 resumable upload (docs: using_resumable_upload_protocol).
 *
 * Text-only posts are not possible through the public API (no Community posts),
 * so this adapter only publishes videos; the composer and validation enforce that.
 */
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";

/**
 * upload: videos.insert. readonly: channels.list?mine=true (the channel's name and avatar).
 * force-ssl: read comment threads and reply (comments.insert). Accounts connected before
 * force-ssl was added must reconnect once; capabilities() says so.
 */
const FORCE_SSL = "https://www.googleapis.com/auth/youtube.force-ssl";
export const YOUTUBE_SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly", FORCE_SSL];

/** Every non-final chunk must be a multiple of 256 KiB and all non-final chunks the same size. */
const CHUNK_BYTES = 32 * 256 * 1024; // 8 MiB
const MAX_CHUNK_RETRIES = 3;

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

async function tokenRequest(params: Record<string, string>, context: string): Promise<TokenSet> {
  const res = await safeFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await readBody(res);
  if (!res.ok) {
    if (res.status === 400 && /invalid_grant/i.test(JSON.stringify(body))) {
      throw new PlatformError(`${context}: access was revoked or expired. Reconnect the account.`, "auth", false, 400);
    }
    throw errorFromResponse(res, body, context);
  }
  const t = body as GoogleTokenResponse;
  if (!t?.access_token) throw new PlatformError(`${context}: Google returned no access token.`, "api", false);
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null, // Google only sends this on the first consent
    expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null,
    scopes: t.scope ?? null,
  };
}

async function fetchChannel(accessToken: string): Promise<AccountProfile> {
  const res = await safeFetch(`${API}/channels?part=id,snippet&mine=true`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const body = await readBody(res);
  if (!res.ok) throw errorFromResponse(res, body, "Fetching your YouTube channel");
  type Channel = { id: string; snippet?: { title?: string; customUrl?: string; thumbnails?: Record<string, { url?: string }> } };
  const channel = (body as { items?: Channel[] }).items?.[0];
  if (!channel?.id) {
    throw new PlatformError("This Google account has no YouTube channel. Create one at youtube.com first, then connect again.", "validation", false);
  }
  const thumbs = channel.snippet?.thumbnails ?? {};
  return {
    platformAccountId: channel.id,
    username: channel.snippet?.customUrl?.replace(/^@/, "") ?? null,
    displayName: channel.snippet?.title ?? null,
    profileImageUrl: thumbs.high?.url ?? thumbs.medium?.url ?? thumbs.default?.url ?? null,
  };
}

/** Parse "bytes=0-1048575" -> next byte to send (1048576); no header -> 0. */
function nextOffset(rangeHeader: string | null): number {
  const m = rangeHeader?.match(/bytes=\d+-(\d+)/);
  return m ? Number(m[1]) + 1 : 0;
}

async function startSession(accessToken: string, input: { title: string; description: string; mime: string; total: number }): Promise<string> {
  const res = await safeFetch(`${UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(input.total),
      "X-Upload-Content-Type": input.mime,
    },
    body: JSON.stringify({
      snippet: { title: input.title, description: input.description, categoryId: "22" /* People & Blogs */ },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
    }),
  });
  if (!res.ok) throw errorFromResponse(res, await readBody(res), "Starting the YouTube upload");
  const location = res.headers.get("location");
  if (!location) throw new PlatformError("YouTube did not return an upload URL.", "api", true);
  return location;
}

/** Ask YouTube how many bytes it already has, so an interrupted upload resumes instead of restarting. */
async function queryOffset(sessionUrl: string, total: number): Promise<{ offset: number; done?: { id: string } }> {
  const res = await safeFetch(sessionUrl, { method: "PUT", headers: { "Content-Length": "0", "Content-Range": `bytes */${total}` } });
  if (res.status === 308) return { offset: nextOffset(res.headers.get("range")) };
  if (res.ok) {
    const id = ((await readBody(res)) as { id?: string } | undefined)?.id;
    if (id) return { offset: total, done: { id } };
  }
  throw errorFromResponse(res, await readBody(res), "Resuming the YouTube upload");
}

async function uploadVideo(accessToken: string, media: PublishInput["media"][number], content: string): Promise<string> {
  const mime = mimeFor(media);
  const total = await mediaSize(media);
  // Title may not contain < or >; the description is the full text.
  const title = youtubeTitle(content).replace(/[<>]/g, "");
  const sessionUrl = await startSession(accessToken, { title, description: content.replace(/[<>]/g, ""), mime, total });

  let offset = 0;
  let retries = 0;
  while (offset < total) {
    const end = Math.min(offset + CHUNK_BYTES, total) - 1;
    const chunk = await readSlice(media.url, offset, end);
    let res: Response;
    try {
      res = await safeFetch(sessionUrl, {
        method: "PUT",
        headers: { "Content-Type": mime, "Content-Range": `bytes ${offset}-${end}/${total}` },
        body: chunk,
        timeoutMs: 180_000,
      });
    } catch (e) {
      // Network drop mid-chunk: ask the server where it got to, then continue from there.
      if (retries++ >= MAX_CHUNK_RETRIES) throw e;
      const q = await queryOffset(sessionUrl, total);
      if (q.done) return q.done.id;
      offset = q.offset;
      continue;
    }

    if (res.status === 308) {
      offset = nextOffset(res.headers.get("range"));
      retries = 0;
      continue;
    }
    if (res.status === 200 || res.status === 201) {
      const id = ((await readBody(res)) as { id?: string } | undefined)?.id;
      if (!id) throw new PlatformError("YouTube accepted the upload but returned no video id.", "api", false);
      return id;
    }
    if ([500, 502, 503, 504].includes(res.status) && retries++ < MAX_CHUNK_RETRIES) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** retries));
      const q = await queryOffset(sessionUrl, total);
      if (q.done) return q.done.id;
      offset = q.offset;
      continue;
    }
    throw errorFromResponse(res, await readBody(res), "Uploading to YouTube");
  }
  // The loop only exits via the final-chunk response above; reaching here means the offset math is off.
  throw new PlatformError("YouTube upload ended without a confirmation.", "api", true);
}

export const youtubeAdapter: PlatformAdapter = {
  platform: "youtube",
  implemented: true,

  getAuthUrl({ state, codeChallenge, redirectUri }) {
    const { GOOGLE_CLIENT_ID } = requireEnv("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET");
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: YOUTUBE_SCOPES.join(" "),
      access_type: "offline", // ask for a refresh token...
      prompt: "consent", // ...every time, so reconnecting always yields one
      include_granted_scopes: "true",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  },

  async exchangeCode({ code, codeVerifier, redirectUri }) {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = requireEnv("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET");
    const tokens = await tokenRequest(
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
      },
      "Exchanging the Google authorization code",
    );
    if (!tokens.refreshToken) {
      throw new PlatformError(
        "Google did not grant offline access, so the connection would stop working within an hour. Remove this app at myaccount.google.com/permissions and connect again.",
        "auth",
        false,
      );
    }
    const channel = await fetchChannel(tokens.accessToken);
    return { ...tokens, ...channel };
  },

  async refreshToken(account: AdapterAccount) {
    if (!account.refreshToken) throw new PlatformError("No refresh token stored. Reconnect the account.", "auth", false);
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = requireEnv("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET");
    return tokenRequest(
      { grant_type: "refresh_token", refresh_token: account.refreshToken, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET },
      "Refreshing the Google token",
    );
  },

  async revokeToken(account: AdapterAccount) {
    const token = account.refreshToken ?? account.accessToken;
    await safeFetch(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
  },

  async fetchMetrics(account: AdapterAccount, ids: string[]) {
    const out = new Map<string, PostMetrics>();
    const num = (v: string | undefined) => (v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
    for (let i = 0; i < ids.length; i += 50) {
      const res = await safeFetch(`${API}/videos?part=statistics&id=${ids.slice(i, i + 50).join(",")}`, {
        headers: { Authorization: `Bearer ${account.accessToken}` },
      });
      const body = await readBody(res);
      if (!res.ok) throw errorFromResponse(res, body, "Reading YouTube video statistics");
      type Item = { id: string; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } };
      for (const v of (body as { items?: Item[] }).items ?? []) {
        out.set(v.id, { likes: num(v.statistics?.likeCount), comments: num(v.statistics?.commentCount), impressions: num(v.statistics?.viewCount) });
      }
    }
    return out;
  },

  capabilities(account) {
    const comments = !account.scopes || account.scopes.split(" ").includes(FORCE_SSL);
    return { metrics: true, comments, note: comments ? undefined : "Reconnect YouTube once to allow reading and replying to comments." };
  },

  /** Recent comment threads across the whole channel: one call (1 quota unit), not one per video. */
  async fetchComments(account, { since }) {
    const auth = { Authorization: `Bearer ${account.accessToken}` };
    const params = new URLSearchParams({
      part: "snippet,replies",
      allThreadsRelatedToChannelId: account.platformAccountId,
      maxResults: "100",
      order: "time",
      textFormat: "plainText",
    });
    const res = await safeFetch(`${API}/commentThreads?${params}`, { headers: auth });
    const body = await readBody(res);
    if (!res.ok) throw errorFromResponse(res, body, "Reading YouTube comments");

    type C = { id: string; snippet?: { authorDisplayName?: string; authorProfileImageUrl?: string; authorChannelUrl?: string; authorChannelId?: { value?: string }; textOriginal?: string; textDisplay?: string; likeCount?: number; publishedAt?: string } };
    type Thread = { id: string; snippet?: { videoId?: string; topLevelComment?: C; canReply?: boolean }; replies?: { comments?: C[] } };
    const threads = ((body as { items?: Thread[] }).items ?? []).filter((t) => {
      const c = t.snippet?.topLevelComment;
      return c && t.snippet?.videoId && new Date(c.snippet?.publishedAt ?? 0) >= since && c.snippet?.authorChannelId?.value !== account.platformAccountId;
    });

    // Titles and thumbnails for the inbox, 50 videos per call (1 unit each).
    const videoIds = [...new Set(threads.map((t) => t.snippet!.videoId!))];
    const videos = new Map<string, { title?: string; thumb?: string }>();
    for (let i = 0; i < videoIds.length; i += 50) {
      const r = await safeFetch(`${API}/videos?part=snippet&id=${videoIds.slice(i, i + 50).join(",")}`, { headers: auth });
      const b = await readBody(r);
      if (!r.ok) throw errorFromResponse(r, b, "Reading YouTube video titles");
      type V = { id: string; snippet?: { title?: string; thumbnails?: Record<string, { url?: string }> } };
      for (const v of (b as { items?: V[] }).items ?? []) videos.set(v.id, { title: v.snippet?.title, thumb: v.snippet?.thumbnails?.medium?.url ?? v.snippet?.thumbnails?.default?.url });
    }

    return threads.map((t) => {
      const c = t.snippet!.topLevelComment!;
      const s = c.snippet ?? {};
      const videoId = t.snippet!.videoId!;
      const handle = s.authorChannelUrl?.match(/\/@([^/?#]+)/)?.[1] ?? null;
      return {
        platformCommentId: c.id,
        platformPostId: videoId,
        postUrl: `https://www.youtube.com/watch?v=${videoId}&lc=${c.id}`,
        postTitle: videos.get(videoId)?.title ?? null,
        postThumbnailUrl: videos.get(videoId)?.thumb ?? null,
        authorName: s.authorDisplayName?.replace(/^@/, "") ?? null,
        authorHandle: handle ? decodeURIComponent(handle) : null,
        authorImageUrl: s.authorProfileImageUrl ?? null,
        text: s.textOriginal ?? s.textDisplay ?? "",
        likeCount: s.likeCount ?? null,
        createdAt: new Date(s.publishedAt ?? Date.now()),
        ownerReplied: (t.replies?.comments ?? []).some((r) => r.snippet?.authorChannelId?.value === account.platformAccountId),
      };
    });
  },

  /** comments.insert with parentId = the top-level comment (50 quota units). */
  async replyToComment(account, comment, text) {
    const res = await safeFetch(`${API}/comments?part=snippet`, {
      method: "POST",
      headers: { Authorization: `Bearer ${account.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ snippet: { parentId: comment.platformCommentId, textOriginal: text } }),
    });
    const body = await readBody(res);
    if (!res.ok) {
      const err = errorFromResponse(res, body, "Replying on YouTube");
      if (res.status === 403 && /insufficient|scope/i.test(err.message)) {
        throw new PlatformError("This YouTube connection was made before comment replies were added. Reconnect YouTube once.", "api", false, 403);
      }
      throw err;
    }
    const id = (body as { id?: string } | undefined)?.id;
    if (!id) throw new PlatformError("YouTube accepted the reply but returned no id.", "api", false);
    return { platformReplyId: id };
  },

  async publish({ account, content, media, asVideo }: PublishInput): Promise<PublishResult> {
    const videos = media.filter((m) => m.type === "video");
    if (!asVideo) throw new PlatformError('YouTube only supports video posts. Turn on "Post as video".', "validation", false);
    if (videos.length !== 1) throw new PlatformError("Attach exactly one video to publish to YouTube.", "validation", false);
    if (!content.trim()) throw new PlatformError("Add a title on the first line of the text.", "validation", false);

    let id: string;
    try {
      id = await uploadVideo(account.accessToken, videos[0], content);
    } catch (e) {
      // Quota exhaustion is a hard stop until the daily reset; say so instead of retrying.
      if (e instanceof PlatformError && /quota/i.test(e.message)) {
        throw new PlatformError(`YouTube's daily upload quota for this app is used up. ${extractMessage(e.message, "")}`.trim(), "api", false);
      }
      throw e;
    }
    return { platformPostId: id, url: `https://www.youtube.com/watch?v=${id}` };
  },
};
