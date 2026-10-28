import { getEnv, isConfigured, requireEnv } from "@/lib/env";
import { errorFromResponse, readBody, safeFetch } from "@/lib/platforms/http";
import { withTransform } from "@/lib/platforms/media-io";
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
 * Instagram adapter. Works with Instagram professional accounts (Business or Creator). Two login flows:
 *
 * 1. "Instagram API with Instagram Login" (Business Login for Instagram), for apps that still have it.
 *    Verified against developers.facebook.com/docs/instagram-platform:
 *      authorize   https://www.instagram.com/oauth/authorize            (scopes comma separated)
 *      token       POST https://api.instagram.com/oauth/access_token    -> short-lived (1 hour)
 *      long-lived  GET  https://graph.instagram.com/access_token?grant_type=ig_exchange_token   (60 days)
 *      refresh     GET  https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token
 *                  (only while still valid and at least 24 hours old)
 *
 * 2. "Unified login" (used when INSTAGRAM_CONFIG_ID is set). Since late 2026 new Meta apps only get this:
 *    Facebook Login for Business with a configuration of Instagram assets. Not yet in Meta's public docs;
 *    built from the dashboard's generated Login URL and the Facebook Login for Business docs:
 *      authorize   https://www.facebook.com/<v>/dialog/oauth?config_id=...&response_type=code&override_default_response_type=true
 *      token       GET https://graph.facebook.com/<v>/oauth/access_token
 *      long-lived  GET https://graph.facebook.com/<v>/oauth/access_token?grant_type=fb_exchange_token
 *                  (skipped when the token has no expiry, e.g. a business integration system user token)
 *      account     tried in order: graph.instagram.com/me with the same token, then
 *                  graph.facebook.com/me/accounts?fields=instagram_business_account (Page-linked accounts)
 *    The host that worked is stored as metadata.graph and used for every later call.
 *
 * Both hosts share the publishing API:
 *   publish     POST /<IG_ID>/media (container) -> GET /<container>?fields=status_code -> POST /<IG_ID>/media_publish
 *   comments    GET /<media>/comments, POST /<comment>/replies { message }
 * Images must be JPEG: ImageKit converts on the fly (tr=f-jpg). `caption` cannot be read back
 * with Instagram Login (Facebook Login only), so the inbox shows our own text for our posts.
 */
const AUTH_URL = "https://www.instagram.com/oauth/authorize";
const TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH = "https://graph.instagram.com";
const FB_GRAPH = "https://graph.facebook.com";
export const INSTAGRAM_GRAPH_VERSION = "v26.0";
const API = `${GRAPH}/${INSTAGRAM_GRAPH_VERSION}`;
const FB_API = `${FB_GRAPH}/${INSTAGRAM_GRAPH_VERSION}`;
const FB_DIALOG = `https://www.facebook.com/${INSTAGRAM_GRAPH_VERSION}/dialog/oauth`;

export const INSTAGRAM_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_comments",
  "instagram_business_manage_insights",
];

const DAY_MS = 86_400_000;
export const IG_MAX_ITEMS = 10;
export const IG_REEL_MAX_BYTES = 300 * 1024 * 1024;
/** How long one attempt waits for Instagram to process media before handing back to the retry loop. */
const PROCESSING_WAIT_MS = 150_000;

/** A token and the Graph host it works on. */
type Conn = { token: string; api: string };

/** Unified login is used when the Meta app has a login configuration (new apps have no other option). */
const usesUnifiedLogin = () => isConfigured("INSTAGRAM_CONFIG_ID");

/** Accounts connected through unified login with a Page-linked account live on graph.facebook.com. */
const connOf = (account: Pick<AdapterAccount, "accessToken" | "metadata">): Conn => ({
  token: account.accessToken,
  api: account.metadata?.graph === "facebook" ? FB_API : API,
});

type GraphError = { message?: string; code?: number; error_subcode?: number; error_user_msg?: string; is_transient?: boolean };

/** Graph errors come back as HTTP 400 with a code; the code, not the status, says what happened. */
export function igError(res: Response, body: unknown, context: string): PlatformError {
  const e = (body as { error?: GraphError } | undefined)?.error;
  if (!e || typeof e !== "object") return errorFromResponse(res, body, context);
  const msg = (e.error_user_msg || e.message || `failed (${res.status})`).slice(0, 400);
  if (e.code === 190 || res.status === 401) return new PlatformError(`${context}: ${msg} Reconnect the account.`, "auth", false, res.status);
  if (e.error_subcode === 2207042) {
    return new PlatformError("Instagram's publishing limit for this account was reached (posts per 24 hours). Try again later.", "rate_limit", false, res.status);
  }
  if ([4, 17, 32, 613].includes(e.code ?? -1) || res.status === 429) {
    return new PlatformError(`${context}: rate limited by Instagram, will retry. ${msg}`, "rate_limit", true, res.status);
  }
  if (e.is_transient || e.code === 1 || e.code === 2 || res.status >= 500) return new PlatformError(`${context}: ${msg}`, "api", true, res.status);
  return new PlatformError(`${context}: ${msg}`, "api", false, res.status);
}

async function graph<T>(
  method: "GET" | "POST",
  path: string,
  c: Conn,
  params: Record<string, string>,
  context: string,
  base = c.api,
): Promise<T> {
  const query = new URLSearchParams({ ...params, access_token: c.token });
  const res =
    method === "GET"
      ? await safeFetch(`${base}${path}?${query}`)
      : await safeFetch(`${base}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: query.toString(),
        });
  const body = await readBody(res);
  if (!res.ok) throw igError(res, body, context);
  return (body ?? {}) as T;
}

/** Instagram only accepts JPEG. ImageKit converts (and caps the width at Instagram's 1440px) on the fly. */
export const jpegUrl = (url: string) => withTransform(url, "f-jpg,q-90,w-1440,c-at_max");

/** The untouched upload, so ImageKit never serves a re-encoded or WebM variant to Instagram's fetcher. */
export const originalUrl = (url: string) => withTransform(url, "orig-true");

async function fetchProfile(c: Conn): Promise<AccountProfile> {
  const me = await graph<{ id?: string; user_id?: string | number; username?: string; name?: string; profile_picture_url?: string; account_type?: string }>(
    "GET",
    "/me",
    c,
    { fields: "id,user_id,username,name,profile_picture_url,account_type" },
    "Fetching your Instagram profile",
  );
  const igId = me.user_id !== undefined ? String(me.user_id) : me.id;
  if (!igId) throw new PlatformError("Instagram did not return an account id.", "api", false);
  return {
    platformAccountId: igId,
    username: me.username ?? null,
    displayName: me.name || me.username || null,
    profileImageUrl: me.profile_picture_url ?? null,
    // Meta's deauthorize / data-deletion callbacks may identify the user by the app-scoped id.
    metadata: { appScopedId: me.id ?? null, accountType: me.account_type ?? null },
  };
}

type IgUser = { id: string; username?: string; name?: string; profile_picture_url?: string };

/**
 * Unified login: find the Instagram professional account behind a Facebook-issued token.
 * Logs which route worked (never the token) so a first live connection can be diagnosed in Vercel's logs.
 */
async function findUnifiedAccount(token: string): Promise<AccountProfile> {
  const tried: string[] = [];
  try {
    const profile = await fetchProfile({ token, api: API });
    console.info("[instagram] unified login: account found on graph.instagram.com");
    return { ...profile, metadata: { ...profile.metadata, graph: "instagram" } };
  } catch (e) {
    if (e instanceof PlatformError && e.retryable) throw e;
    tried.push(`graph.instagram.com: ${e instanceof Error ? e.message : String(e)}`);
  }

  const fb: Conn = { token, api: FB_API };
  const me = await graph<{ id?: string }>("GET", "/me", fb, { fields: "id" }, "Reading your Facebook login");

  // A business integration token carries the Instagram accounts it was granted as granular scope targets.
  const granted = await grantedInstagramIds(token);
  tried.push(`debug_token: ${granted.length} Instagram account id(s) granted`);
  // Stopgap: a system user token may reach an account it does not list. INSTAGRAM_ACCOUNT_ID names it directly.
  const known = getEnv().INSTAGRAM_ACCOUNT_ID;
  if (known && !granted.includes(known)) granted.push(known);
  for (const id of granted) {
    try {
      const ig = await graph<IgUser>("GET", `/${id}`, fb, { fields: "id,username,name,profile_picture_url" }, "Reading your Instagram account");
      console.info("[instagram] unified login: account found via the token's granted assets");
      return {
        platformAccountId: ig.id ?? id,
        username: ig.username ?? null,
        displayName: ig.name || ig.username || null,
        profileImageUrl: ig.profile_picture_url ?? null,
        metadata: { appScopedId: me.id ?? null, accountType: null, graph: "facebook" },
      };
    } catch (e) {
      if (e instanceof PlatformError && e.retryable) throw e;
      tried.push(`asset ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // System user tokens reach accounts through the client's business portfolio rather than per-token targets.
  for (const id of await businessInstagramIds(fb, tried)) {
    try {
      const ig = await graph<IgUser>("GET", `/${id}`, fb, { fields: "id,username,name,profile_picture_url" }, "Reading your Instagram account");
      console.info("[instagram] unified login: account found via the business portfolio");
      return {
        platformAccountId: ig.id ?? id,
        username: ig.username ?? null,
        displayName: ig.name || ig.username || null,
        profileImageUrl: ig.profile_picture_url ?? null,
        metadata: { appScopedId: me.id ?? null, accountType: null, graph: "facebook" },
      };
    } catch (e) {
      if (e instanceof PlatformError && e.retryable) throw e;
      tried.push(`business asset ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const pages = await graph<{ data?: { id: string; instagram_business_account?: IgUser }[] }>(
    "GET",
    "/me/accounts",
    fb,
    { fields: "id,instagram_business_account{id,username,name,profile_picture_url}", limit: "100" },
    "Finding your Instagram account",
  );
  const ig = pages.data?.find((p) => p.instagram_business_account)?.instagram_business_account;
  if (ig) {
    console.info(`[instagram] unified login: account found via a Facebook Page (${pages.data?.length ?? 0} page(s) granted)`);
    return {
      platformAccountId: ig.id,
      username: ig.username ?? null,
      displayName: ig.name || ig.username || null,
      profileImageUrl: ig.profile_picture_url ?? null,
      metadata: { appScopedId: me.id ?? null, accountType: null, graph: "facebook" },
    };
  }
  tried.push(`graph.facebook.com: ${pages.data?.length ?? 0} page(s) granted, none with an Instagram account`);
  console.warn(`[instagram] unified login: no Instagram account found. ${tried.join(" | ")}`);
  throw new PlatformError(
    "Meta did not give access to an Instagram professional account. Connect again and select your Instagram account (and its Facebook Page, if asked) in the login window.",
    "validation",
    false,
  );
}

type DebugToken = { data?: { type?: string; scopes?: string[]; granular_scopes?: { scope: string; target_ids?: string[] }[] } };

/** Inspects a token with the app's own credentials (GET /debug_token). Null when Meta will not say. */
async function debugToken(token: string): Promise<DebugToken["data"] | null> {
  const { INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET } = requireEnv("INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET");
  try {
    const r = await graph<DebugToken>("GET", "/debug_token", { token: `${INSTAGRAM_APP_ID}|${INSTAGRAM_APP_SECRET}`, api: FB_API }, { input_token: token }, "Inspecting the Instagram token");
    const d = r.data ?? null;
    console.info(`[instagram] unified login: token type ${d?.type ?? "?"}, scopes ${(d?.scopes ?? []).join(",") || "none"}`);
    return d;
  } catch (e) {
    console.warn(`[instagram] unified login: debug_token failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Instagram account ids the user granted, from the instagram_* granular scopes. */
async function grantedInstagramIds(token: string): Promise<string[]> {
  const d = await debugToken(token);
  const granular = d?.granular_scopes ?? [];
  console.info(`[instagram] unified login: granular scopes ${granular.map((s) => `${s.scope}(${s.target_ids?.length ?? "all"})`).join(",") || "none"}`);
  const ids = granular.filter((s) => s.scope.startsWith("instagram_")).flatMap((s) => s.target_ids ?? []);
  return [...new Set(ids)];
}

/**
 * Instagram accounts reachable through the business portfolio behind a system user token. Meta does not
 * document which edge a unified-login token uses, so the candidates are tried in turn and each outcome is logged.
 */
async function businessInstagramIds(fb: Conn, tried: string[]): Promise<string[]> {
  const probe = async (path: string, params: Record<string, string> = {}) => {
    try {
      const r = await graph<{ data?: { id: string }[] }>("GET", path, fb, { fields: "id", limit: "25", ...params }, "Finding your Instagram account");
      const ids = (r.data ?? []).map((a) => a.id);
      tried.push(`${path}: ${ids.length}`);
      return ids;
    } catch (e) {
      if (e instanceof PlatformError && e.retryable) throw e;
      tried.push(`${path}: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
      return [];
    }
  };
  let business: string | undefined;
  try {
    business = (await graph<{ client_business_id?: string }>("GET", "/me", fb, { fields: "client_business_id" }, "Reading your business")).client_business_id;
  } catch (e) {
    if (e instanceof PlatformError && e.retryable) throw e;
    tried.push(`client_business_id: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
  }
  const ids = [...(await probe("/me/instagram_accounts"))];
  if (business) {
    for (const edge of ["instagram_business_accounts", "owned_instagram_accounts", "instagram_accounts"]) ids.push(...(await probe(`/${business}/${edge}`)));
  }
  return [...new Set(ids)];
}

async function grantedPermissions(token: string): Promise<string | null> {
  try {
    const r = await graph<{ data?: { permission: string; status: string }[] }>("GET", "/me/permissions", { token, api: FB_API }, {}, "Reading granted permissions");
    const granted = (r.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission);
    return granted.length ? granted.join(",") : null;
  } catch {
    return null; // unknown: capabilities() then assumes everything was granted
  }
}

/** Facebook user tokens become 60-day tokens; a token without expiry (system user) is kept as is. */
async function longLivedFacebookToken(token: string, expiresIn: number | undefined): Promise<{ token: string; expiresAt: Date | null }> {
  if (!expiresIn) return { token, expiresAt: null };
  const { INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET } = requireEnv("INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET");
  const long = await graph<{ access_token?: string; expires_in?: number }>(
    "GET",
    "/oauth/access_token",
    { token, api: FB_API },
    { grant_type: "fb_exchange_token", client_id: INSTAGRAM_APP_ID, client_secret: INSTAGRAM_APP_SECRET, fb_exchange_token: token },
    "Getting a long-lived Instagram token",
  );
  if (!long.access_token) throw new PlatformError("Meta returned no long-lived token.", "api", false);
  return { token: long.access_token, expiresAt: new Date(Date.now() + (long.expires_in ?? 60 * 86_400) * 1000) };
}

type ContainerStatus = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

async function containerStatus(c: Conn, id: string): Promise<{ code: ContainerStatus; detail?: string }> {
  const r = await graph<{ status_code?: ContainerStatus; status?: string }>("GET", `/${id}`, c, { fields: "status_code,status" }, "Checking Instagram media status");
  return { code: r.status_code ?? "IN_PROGRESS", detail: r.status };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until Instagram has fetched and processed the media, or hand back to the retry loop. */
async function waitForContainer(c: Conn, id: string): Promise<ContainerStatus> {
  const deadline = Date.now() + PROCESSING_WAIT_MS;
  for (let attempt = 0; ; attempt += 1) {
    const s = await containerStatus(c, id);
    if (s.code === "FINISHED" || s.code === "PUBLISHED") return s.code;
    if (s.code === "ERROR") {
      throw new PlatformError(`Instagram could not process the media${s.detail ? `: ${s.detail}` : ""}. Check the format (JPEG photos; MP4/MOV video for reels).`, "validation", false);
    }
    if (s.code === "EXPIRED") return "EXPIRED";
    if (Date.now() > deadline) throw new PlatformError("Instagram is still processing the video; will check again shortly.", "api", true);
    await sleep(Math.min(2000 * 2 ** attempt, 15_000));
  }
}

async function createContainer(c: Conn, igId: string, params: Record<string, string>): Promise<string> {
  const r = await graph<{ id?: string }>("POST", `/${igId}/media`, c, params, "Uploading to Instagram");
  if (!r.id) throw new PlatformError("Instagram did not return a media container id.", "api", false);
  return r.id;
}

async function buildContainer(c: Conn, igId: string, content: string, media: PublishMedia[]): Promise<string> {
  const caption: Record<string, string> = content ? { caption: content } : {};
  if (media.length === 1) {
    const m = media[0];
    return m.type === "video"
      ? createContainer(c, igId, { media_type: "REELS", video_url: originalUrl(m.url), share_to_feed: "true", ...caption })
      : createContainer(c, igId, { image_url: jpegUrl(m.url), ...caption });
  }
  const children: string[] = [];
  for (const m of media) {
    children.push(
      await createContainer(c, igId, m.type === "video" ? { media_type: "VIDEO", video_url: originalUrl(m.url), is_carousel_item: "true" } : { image_url: jpegUrl(m.url), is_carousel_item: "true" }),
    );
  }
  // Children must be processed before the carousel container can reference them.
  for (const child of children) {
    if ((await waitForContainer(c, child)) === "EXPIRED") throw new PlatformError("An Instagram carousel item expired before publishing; will retry.", "api", true);
  }
  return createContainer(c, igId, { media_type: "CAROUSEL", children: children.join(","), ...caption });
}

async function permalinkOf(c: Conn, mediaId: string): Promise<string | undefined> {
  try {
    return (await graph<{ permalink?: string }>("GET", `/${mediaId}`, c, { fields: "permalink" }, "Reading the Instagram post link")).permalink;
  } catch {
    return undefined; // the post is live; a missing link is not worth failing over
  }
}

async function latestMedia(c: Conn, igId: string): Promise<{ id: string; permalink?: string } | undefined> {
  const r = await graph<{ data?: { id: string; permalink?: string }[] }>("GET", `/${igId}/media`, c, { fields: "id,permalink", limit: "1" }, "Reading recent Instagram posts");
  return r.data?.[0];
}

async function publish({ account, content, media, state, saveState }: PublishInput): Promise<PublishResult> {
  const c = connOf(account);
  const igId = account.platformAccountId;

  // A previous attempt already published: never publish twice.
  if (typeof state?.mediaId === "string") {
    return { platformPostId: state.mediaId, url: (state.permalink as string | undefined) ?? (await permalinkOf(c, state.mediaId)) };
  }
  if (media.length === 0) throw new PlatformError("Instagram needs at least one photo or video.", "validation", false);
  if (media.length > IG_MAX_ITEMS) throw new PlatformError(`Instagram allows at most ${IG_MAX_ITEMS} items in a carousel.`, "validation", false);
  if (media.length === 1 && media[0].type === "video" && (media[0].sizeBytes ?? 0) > IG_REEL_MAX_BYTES) {
    throw new PlatformError("Instagram reels must be 300 MB or smaller.", "validation", false);
  }

  let containerId = typeof state?.containerId === "string" ? state.containerId : undefined;
  if (containerId) {
    const status = await waitForContainer(c, containerId);
    if (status === "PUBLISHED") {
      // Published, but the media id was lost with the previous attempt: it is the newest post.
      const latest = await latestMedia(c, igId);
      if (!latest) throw new PlatformError("Instagram reports the post as published but it could not be found.", "api", false);
      await saveState?.({ containerId, mediaId: latest.id, permalink: latest.permalink });
      return { platformPostId: latest.id, url: latest.permalink };
    }
    if (status === "EXPIRED") containerId = undefined;
  }
  if (!containerId) {
    containerId = await buildContainer(c, igId, content, media);
    await saveState?.({ containerId });
    if ((await waitForContainer(c, containerId)) === "EXPIRED") {
      throw new PlatformError("Instagram's upload expired before it could be published; will retry.", "api", true);
    }
  }

  const published = await graph<{ id?: string }>("POST", `/${igId}/media_publish`, c, { creation_id: containerId }, "Publishing to Instagram");
  if (!published.id) throw new PlatformError("Instagram accepted the post but returned no id.", "api", false);
  await saveState?.({ containerId, mediaId: published.id });
  return { platformPostId: published.id, url: await permalinkOf(c, published.id) };
}

type IgComment = { id: string; text?: string; timestamp?: string; username?: string; like_count?: number; replies?: { data?: { username?: string }[] } };
type IgMedia = { id: string; media_type?: string; media_url?: string; thumbnail_url?: string; permalink?: string; timestamp?: string; comments_count?: number };

async function commentsOf(c: Conn, mediaId: string): Promise<IgComment[]> {
  const read = (fields: string) => graph<{ data?: IgComment[] }>("GET", `/${mediaId}/comments`, c, { fields, limit: "50" }, "Reading Instagram comments");
  try {
    return (await read("id,text,timestamp,username,like_count,replies{id,username}")).data ?? [];
  } catch (e) {
    // Field availability differs between Instagram Login and Facebook Login; fall back to the documented minimum.
    if (e instanceof PlatformError && e.kind === "api" && !e.retryable) return (await read("id,text,timestamp")).data ?? [];
    throw e;
  }
}

export const instagramAdapter: PlatformAdapter = {
  platform: "instagram",
  implemented: true,
  refreshWindowMs: 20 * DAY_MS,
  canRefresh: () => true, // the long-lived token refreshes itself; no separate refresh token

  getAuthUrl({ state, redirectUri }) {
    const { INSTAGRAM_APP_ID } = requireEnv("INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET");
    if (usesUnifiedLogin()) {
      const { INSTAGRAM_CONFIG_ID } = requireEnv("INSTAGRAM_CONFIG_ID");
      const url = new URL(FB_DIALOG);
      url.search = new URLSearchParams({
        client_id: INSTAGRAM_APP_ID,
        config_id: INSTAGRAM_CONFIG_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        override_default_response_type: "true",
        state,
      }).toString();
      return url.toString();
    }
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: INSTAGRAM_APP_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: INSTAGRAM_SCOPES.join(","),
      state,
    }).toString();
    return url.toString();
  },

  async exchangeCode({ code, redirectUri }) {
    const { INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET } = requireEnv("INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET");
    if (usesUnifiedLogin()) {
      const res = await safeFetch(
        `${FB_API}/oauth/access_token?${new URLSearchParams({ client_id: INSTAGRAM_APP_ID, client_secret: INSTAGRAM_APP_SECRET, redirect_uri: redirectUri, code: code.replace(/#_$/, "") })}`,
      );
      const body = await readBody(res);
      if (!res.ok) throw igError(res, body, "Exchanging the Instagram authorization code");
      const short = body as { access_token?: string; expires_in?: number; token_type?: string } | undefined;
      if (!short?.access_token) throw new PlatformError("Meta returned no access token.", "api", false);
      console.info(`[instagram] unified login: token received (type ${short.token_type ?? "?"}, expires_in ${short.expires_in ?? "none"})`);
      const long = await longLivedFacebookToken(short.access_token, short.expires_in);
      const profile = await findUnifiedAccount(long.token);
      const tokens: TokenSet = { accessToken: long.token, refreshToken: null, expiresAt: long.expiresAt, scopes: await grantedPermissions(long.token) };
      return { ...tokens, ...profile };
    }

    const res = await safeFetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: INSTAGRAM_APP_ID,
        client_secret: INSTAGRAM_APP_SECRET,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code: code.replace(/#_$/, ""),
      }).toString(),
    });
    const body = await readBody(res);
    if (!res.ok) throw igError(res, body, "Exchanging the Instagram authorization code");
    // Documented as { data: [{ access_token, user_id, permissions }] }; older responses are flat.
    type Short = { access_token?: string; permissions?: string | string[] };
    const short = ((body as { data?: Short[] })?.data?.[0] ?? body) as Short;
    if (!short?.access_token) throw new PlatformError("Instagram returned no access token.", "api", false);

    const long = await graph<{ access_token?: string; expires_in?: number }>(
      "GET",
      "/access_token",
      { token: short.access_token, api: API },
      { grant_type: "ig_exchange_token", client_secret: INSTAGRAM_APP_SECRET },
      "Getting a long-lived Instagram token",
      GRAPH,
    );
    if (!long.access_token) throw new PlatformError("Instagram returned no long-lived token.", "api", false);
    const profile = await fetchProfile({ token: long.access_token, api: API });
    const scopes = Array.isArray(short.permissions) ? short.permissions.join(",") : (short.permissions ?? null);
    const tokens: TokenSet = {
      accessToken: long.access_token,
      refreshToken: null,
      expiresAt: new Date(Date.now() + (long.expires_in ?? 60 * 86_400) * 1000),
      scopes,
    };
    return { ...tokens, ...profile };
  },

  async refreshToken(account: AdapterAccount) {
    if (account.metadata?.graph === "facebook") {
      // A Facebook user token is renewed by exchanging it again while it is still valid.
      const long = await longLivedFacebookToken(account.accessToken, 1);
      return { accessToken: long.token, refreshToken: null, expiresAt: long.expiresAt };
    }
    const r = await graph<{ access_token?: string; expires_in?: number }>(
      "GET",
      "/refresh_access_token",
      connOf(account),
      { grant_type: "ig_refresh_token" },
      "Refreshing the Instagram token",
      GRAPH,
    );
    if (!r.access_token) throw new PlatformError("Instagram returned no refreshed token.", "api", false);
    return { accessToken: r.access_token, refreshToken: null, expiresAt: new Date(Date.now() + (r.expires_in ?? 60 * 86_400) * 1000) };
  },

  capabilities(account) {
    // Instagram Login grants instagram_business_manage_comments; Facebook Login grants instagram_manage_comments.
    const comments = !account.scopes || /instagram_(business_)?manage_comments/.test(account.scopes);
    return {
      metrics: true,
      comments,
      note: comments ? undefined : "Reconnect and allow comment access to see and reply to comments.",
    };
  },

  publish,

  async fetchMetrics(account: AdapterAccount, ids: string[]) {
    const c = connOf(account);
    const out = new Map<string, PostMetrics>();
    for (const id of ids) {
      let basic: { like_count?: number; comments_count?: number };
      try {
        basic = await graph("GET", `/${id}`, c, { fields: "like_count,comments_count" }, "Reading Instagram post metrics");
      } catch (e) {
        if (e instanceof PlatformError && (e.kind === "auth" || e.retryable)) throw e;
        continue; // deleted on Instagram, or not readable: keep the old numbers
      }
      let views: number | null = null;
      try {
        type Insight = { name: string; values?: { value?: number }[]; total_value?: { value?: number } };
        const r = await graph<{ data?: Insight[] }>("GET", `/${id}/insights`, c, { metric: "views" }, "Reading Instagram insights");
        const v = r.data?.find((d) => d.name === "views");
        views = v?.total_value?.value ?? v?.values?.[0]?.value ?? null;
      } catch (e) {
        if (e instanceof PlatformError && e.kind === "auth") throw e;
        // Insights need instagram_business_manage_insights and are not available for every media type.
      }
      out.set(id, { likes: basic.like_count ?? null, comments: basic.comments_count ?? null, impressions: views });
    }
    return out;
  },

  /** Comments on the account's 25 most recent posts (not only the ones published through us). */
  async fetchComments(account, { since }) {
    const c = connOf(account);
    const recent = await graph<{ data?: IgMedia[] }>(
      "GET",
      `/${account.platformAccountId}/media`,
      c,
      { fields: "id,media_type,media_url,thumbnail_url,permalink,timestamp,comments_count", limit: "25" },
      "Reading recent Instagram posts",
    );
    const media = (recent.data ?? []).filter((m) => (m.comments_count ?? 0) > 0).slice(0, 15);
    const out: PlatformComment[] = [];
    const me = account.username?.toLowerCase();
    for (const m of media) {
      for (const cm of await commentsOf(c, m.id)) {
        const createdAt = cm.timestamp ? new Date(cm.timestamp) : new Date();
        if (createdAt < since) continue;
        if (me && cm.username?.toLowerCase() === me) continue; // the owner's own comment
        out.push({
          platformCommentId: cm.id,
          platformPostId: m.id,
          postUrl: m.permalink ?? null,
          postTitle: null,
          postThumbnailUrl: m.media_type === "VIDEO" ? (m.thumbnail_url ?? null) : (m.media_url ?? m.thumbnail_url ?? null),
          authorName: null,
          authorHandle: cm.username ?? null,
          authorImageUrl: null,
          text: cm.text ?? "",
          likeCount: cm.like_count ?? null,
          createdAt,
          ownerReplied: Boolean(me && cm.replies?.data?.some((r) => r.username?.toLowerCase() === me)),
        });
      }
    }
    return out;
  },

  async replyToComment(account, comment, text) {
    const r = await graph<{ id?: string }>("POST", `/${comment.platformCommentId}/replies`, connOf(account), { message: text }, "Replying on Instagram");
    if (!r.id) throw new PlatformError("Instagram accepted the reply but returned no id.", "api", false);
    return { platformReplyId: r.id };
  },
};
