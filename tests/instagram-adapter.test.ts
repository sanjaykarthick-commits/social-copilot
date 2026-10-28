import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { igError, instagramAdapter, INSTAGRAM_SCOPES } from "@/lib/platforms/instagram";
import type { AdapterAccount } from "@/lib/platforms/types";
import { installFakeFetch, json, type RecordedRequest } from "./helpers/fake-fetch";

const account: AdapterAccount = {
  id: "acc-ig",
  platform: "instagram",
  platformAccountId: "1784",
  username: "asha.makes",
  displayName: "Asha",
  accessToken: "IGLONG",
  refreshToken: null,
  tokenExpiresAt: null,
  scopes: INSTAGRAM_SCOPES.join(","),
  metadata: {},
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const API = "https://graph.instagram.com/v26.0";
const img = (n = 1) => ({ url: `https://ik.imagekit.io/t/p${n}.png`, type: "image" as const, sizeBytes: 1000 });
const vid = (n = 1, size = 5_000_000) => ({ url: `https://ik.imagekit.io/t/v${n}.mp4`, type: "video" as const, sizeBytes: size });
const params = (r: RecordedRequest) => Object.fromEntries(new URLSearchParams(typeof r.body === "string" ? r.body : new URL(r.url).search));

/**
 * A stateful stand-in for the Instagram Graph API publishing flow: containers start IN_PROGRESS,
 * become FINISHED after `pollsUntilReady` status checks, and PUBLISHED once media_publish is called.
 */
function igServer(opts: { pollsUntilReady?: number; failStatus?: "ERROR" | "EXPIRED"; neverReady?: boolean } = {}) {
  let n = 0;
  const containers = new Map<string, { params: Record<string, string>; polls: number; status: string }>();
  const published: string[] = [];
  const handler = (r: RecordedRequest) => {
    const u = new URL(r.url);
    if (!u.href.startsWith(API)) return undefined;
    const path = u.pathname.replace("/v26.0", "");
    if (r.method === "POST" && path === "/1784/media") {
      const id = `C${++n}`;
      containers.set(id, { params: params(r), polls: 0, status: "IN_PROGRESS" });
      return json({ id });
    }
    if (r.method === "POST" && path === "/1784/media_publish") {
      const c = containers.get(params(r).creation_id);
      if (!c || c.status !== "FINISHED") return json({ error: { message: "Media ID is not available", code: 9007, error_subcode: 2207027 } }, 400);
      c.status = "PUBLISHED";
      published.push(params(r).creation_id);
      return json({ id: "M1" });
    }
    if (r.method === "GET" && u.searchParams.get("fields") === "status_code,status") {
      const c = containers.get(path.slice(1));
      if (!c) return json({ error: { message: "Unsupported get request", code: 100 } }, 400);
      c.polls += 1;
      if (c.status === "IN_PROGRESS" && !opts.neverReady && c.polls > (opts.pollsUntilReady ?? 1)) c.status = opts.failStatus ?? "FINISHED";
      return json({ status_code: c.status, ...(c.status === "ERROR" ? { status: "Error: The video format is not supported." } : {}), id: path.slice(1) });
    }
    if (r.method === "GET" && path === "/M1" && u.searchParams.get("fields") === "permalink") return json({ permalink: "https://www.instagram.com/p/ABC/" });
    if (r.method === "GET" && path === "/1784/media") return json({ data: [{ id: "M9", permalink: "https://www.instagram.com/p/LATEST/" }] });
    return undefined;
  };
  return { handler, containers, published };
}

describe("Instagram adapter: OAuth", () => {
  it("asks for the four business scopes (comma separated) on instagram.com, without PKCE", () => {
    const url = new URL(instagramAdapter.getAuthUrl({ state: "st", codeChallenge: "CH", redirectUri: "https://app.test/api/oauth/instagram/callback" }));
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-ig-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_insights",
    );
    expect(url.searchParams.has("code_challenge")).toBe(false);
  });

  it("exchanges the code, upgrades to a 60-day token, and stores the professional account id", async () => {
    const { requests } = installFakeFetch([
      (r) =>
        r.url === "https://api.instagram.com/oauth/access_token"
          ? json({ data: [{ access_token: "SHORT", user_id: "app-1", permissions: "instagram_business_basic,instagram_business_content_publish" }] })
          : undefined,
      (r) => (r.url.startsWith("https://graph.instagram.com/access_token?") ? json({ access_token: "LONG", token_type: "bearer", expires_in: 5_183_944 }) : undefined),
      (r) =>
        r.url.startsWith(`${API}/me?`)
          ? json({ id: "app-1", user_id: 17841400000, username: "asha.makes", name: "Asha", profile_picture_url: "https://scontent.cdninstagram.com/p.jpg", account_type: "Business" })
          : undefined,
    ]);
    const before = Date.now();
    const out = await instagramAdapter.exchangeCode({ code: "CODE#_", codeVerifier: "unused", redirectUri: "https://app.test/cb" });

    expect(params(requests[0])).toEqual({ client_id: "test-ig-id", client_secret: "test-ig-secret", grant_type: "authorization_code", redirect_uri: "https://app.test/cb", code: "CODE" });
    const long = new URL(requests[1].url).searchParams;
    expect(long.get("grant_type")).toBe("ig_exchange_token");
    expect(long.get("client_secret")).toBe("test-ig-secret");
    expect(long.get("access_token")).toBe("SHORT");
    expect(new URL(requests[2].url).searchParams.get("access_token")).toBe("LONG");

    expect(out).toMatchObject({
      accessToken: "LONG",
      refreshToken: null,
      platformAccountId: "17841400000",
      username: "asha.makes",
      displayName: "Asha",
      scopes: "instagram_business_basic,instagram_business_content_publish",
      metadata: { appScopedId: "app-1", accountType: "Business" },
    });
    expect(out.expiresAt!.getTime() - before).toBeGreaterThan(59 * 86_400_000);
  });

  it("also accepts the older flat token response", async () => {
    installFakeFetch([
      (r) => (r.url.startsWith("https://api.instagram.com") ? json({ access_token: "SHORT", user_id: 1 }) : undefined),
      (r) => (r.url.startsWith("https://graph.instagram.com/access_token") ? json({ access_token: "LONG", expires_in: 100 }) : undefined),
      () => json({ id: "app-1", user_id: "99", username: "u" }),
    ]);
    await expect(instagramAdapter.exchangeCode({ code: "C", codeVerifier: "", redirectUri: "r" })).resolves.toMatchObject({ accessToken: "LONG", platformAccountId: "99" });
  });

  it("refreshes the long-lived token itself (no refresh token) and is renewed weeks ahead", async () => {
    const { requests } = installFakeFetch([() => json({ access_token: "LONG2", expires_in: 5_183_944 })]);
    const t = await instagramAdapter.refreshToken(account);
    const u = new URL(requests[0].url);
    expect(u.origin + u.pathname).toBe("https://graph.instagram.com/refresh_access_token");
    expect(u.searchParams.get("grant_type")).toBe("ig_refresh_token");
    expect(u.searchParams.get("access_token")).toBe("IGLONG");
    expect(t.accessToken).toBe("LONG2");
    expect(instagramAdapter.refreshWindowMs).toBeGreaterThanOrEqual(7 * 86_400_000);
    expect(instagramAdapter.canRefresh!({ refreshToken: null })).toBe(true);
  });
});

describe("Instagram adapter: unified login (INSTAGRAM_CONFIG_ID set)", () => {
  const FB = "https://graph.facebook.com/v26.0";
  // Edges a test does not care about answer like Graph does for an unknown or unavailable edge.
  const otherGraph = (r: RecordedRequest) => (r.url.startsWith(FB) ? json({ error: { message: "Unsupported get request", code: 100 } }, 400) : undefined);
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it("sends people to Facebook's dialog with the configuration id instead of scopes", () => {
    vi.stubEnv("INSTAGRAM_CONFIG_ID", "cfg-1");
    resetEnvCache();
    const url = new URL(instagramAdapter.getAuthUrl({ state: "st", codeChallenge: "CH", redirectUri: "https://app.test/api/oauth/instagram/callback" }));
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "test-ig-id",
      config_id: "cfg-1",
      redirect_uri: "https://app.test/api/oauth/instagram/callback",
      response_type: "code",
      override_default_response_type: "true",
      state: "st",
    });
  });

  it("exchanges on graph.facebook.com, upgrades a user token to 60 days, and finds a Page-linked account", async () => {
    vi.stubEnv("INSTAGRAM_CONFIG_ID", "cfg-1");
    resetEnvCache();
    const { requests } = installFakeFetch([
      (r) => {
        const u = new URL(r.url);
        if (u.href.startsWith(`${FB}/oauth/access_token`)) {
          return u.searchParams.get("grant_type") === "fb_exchange_token" ? json({ access_token: "FBLONG", expires_in: 5_183_944 }) : json({ access_token: "FBSHORT", token_type: "bearer", expires_in: 3600 });
        }
        if (u.href.startsWith(`${API}/me?`)) return json({ error: { message: "Invalid OAuth access token", code: 190 } }, 400);
        if (u.pathname === "/v26.0/me" && u.host === "graph.facebook.com") return json({ id: "fb-user-1" });
        if (u.pathname === "/v26.0/me/accounts") return json({ data: [{ id: "page-1" }, { id: "page-2", instagram_business_account: { id: "1784", username: "asha.makes", name: "Asha", profile_picture_url: "https://cdn/p.jpg" } }] });
        if (u.pathname === "/v26.0/me/permissions") return json({ data: [{ permission: "instagram_basic", status: "granted" }, { permission: "instagram_manage_comments", status: "granted" }, { permission: "pages_show_list", status: "declined" }] });
        return undefined;
      },
      otherGraph,
    ]);
    const before = Date.now();
    const out = await instagramAdapter.exchangeCode({ code: "CODE#_", codeVerifier: "", redirectUri: "https://app.test/cb" });

    expect(Object.fromEntries(new URL(requests[0].url).searchParams)).toEqual({ client_id: "test-ig-id", client_secret: "test-ig-secret", redirect_uri: "https://app.test/cb", code: "CODE" });
    expect(new URL(requests[1].url).searchParams.get("fb_exchange_token")).toBe("FBSHORT");
    expect(out).toMatchObject({
      accessToken: "FBLONG",
      refreshToken: null,
      platformAccountId: "1784",
      username: "asha.makes",
      scopes: "instagram_basic,instagram_manage_comments",
      metadata: { appScopedId: "fb-user-1", graph: "facebook" },
    });
    expect(out.expiresAt!.getTime() - before).toBeGreaterThan(59 * 86_400_000);
    expect(instagramAdapter.capabilities!({ scopes: out.scopes ?? null }).comments).toBe(true);
  });

  it("keeps a token without expiry and uses graph.instagram.com when the token works there", async () => {
    vi.stubEnv("INSTAGRAM_CONFIG_ID", "cfg-1");
    resetEnvCache();
    const { requests } = installFakeFetch([
      (r) => (r.url.startsWith(`${FB}/oauth/access_token`) ? json({ access_token: "SYS", token_type: "bearer" }) : undefined),
      (r) => (r.url.startsWith(`${API}/me?`) ? json({ id: "app-1", user_id: "1784", username: "asha.makes" }) : undefined),
      (r) => (r.url.startsWith(`${FB}/me/permissions`) ? json({ data: [] }) : undefined),
    ]);
    const out = await instagramAdapter.exchangeCode({ code: "C", codeVerifier: "", redirectUri: "r" });
    expect(requests.some((r) => new URL(r.url).searchParams.get("grant_type") === "fb_exchange_token")).toBe(false);
    expect(out).toMatchObject({ accessToken: "SYS", expiresAt: null, platformAccountId: "1784", metadata: { graph: "instagram" } });
  });

  it("finds the account of a business integration token (no expiry, no Pages) from its granted assets", async () => {
    vi.stubEnv("INSTAGRAM_CONFIG_ID", "cfg-1");
    resetEnvCache();
    const { requests } = installFakeFetch([
      (r) => {
        const u = new URL(r.url);
        if (u.href.startsWith(`${FB}/oauth/access_token`)) return json({ access_token: "SYS", token_type: "bearer" });
        if (u.href.startsWith(`${API}/me?`)) return json({ error: { message: "Invalid OAuth access token - Cannot parse access token", code: 190 } }, 400);
        if (u.pathname === "/v26.0/debug_token") {
          return json({
            data: {
              type: "SYSTEM_USER",
              scopes: ["instagram_basic", "instagram_content_publish"],
              granular_scopes: [
                { scope: "instagram_basic", target_ids: ["1784"] },
                { scope: "instagram_content_publish", target_ids: ["1784"] },
                { scope: "business_management" },
              ],
            },
          });
        }
        if (u.pathname === "/v26.0/me") return json({ id: "sys-user-1" });
        if (u.pathname === "/v26.0/1784") return json({ id: "1784", username: "asha.makes", name: "Asha" });
        if (u.pathname === "/v26.0/me/permissions") return json({ data: [{ permission: "instagram_basic", status: "granted" }] });
        return undefined;
      },
    ]);
    const out = await instagramAdapter.exchangeCode({ code: "C", codeVerifier: "", redirectUri: "r" });
    const debug = new URL(requests.find((r) => r.url.includes("/debug_token"))!.url).searchParams;
    expect(debug.get("input_token")).toBe("SYS");
    expect(debug.get("access_token")).toBe("test-ig-id|test-ig-secret");
    expect(out).toMatchObject({ accessToken: "SYS", expiresAt: null, platformAccountId: "1784", username: "asha.makes", metadata: { appScopedId: "sys-user-1", graph: "facebook" } });
    expect(requests.some((r) => r.url.includes("/me/accounts"))).toBe(false);
  });

  it("says what to do when no Instagram account was shared", async () => {
    vi.stubEnv("INSTAGRAM_CONFIG_ID", "cfg-1");
    resetEnvCache();
    installFakeFetch([
      (r) => (r.url.startsWith(`${FB}/oauth/access_token`) ? json({ access_token: "SYS" }) : undefined),
      (r) => (r.url.startsWith(`${API}/me?`) ? json({ error: { message: "Invalid OAuth access token", code: 190 } }, 400) : undefined),
      (r) => (new URL(r.url).pathname === "/v26.0/me/accounts" ? json({ data: [] }) : undefined),
      (r) => (new URL(r.url).pathname === "/v26.0/me" ? json({ id: "fb-1" }) : undefined),
      otherGraph,
    ]);
    await expect(instagramAdapter.exchangeCode({ code: "C", codeVerifier: "", redirectUri: "r" })).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining("select your Instagram account"),
    });
  });

  it("publishes, refreshes and replies on graph.facebook.com for a Page-linked account", async () => {
    const fbAccount = { ...account, metadata: { graph: "facebook" } };
    const { requests } = installFakeFetch([
      (r) => (r.url.startsWith(`${FB}/oauth/access_token`) ? json({ access_token: "FBLONG2", expires_in: 5_183_944 }) : undefined),
      () => json({ id: "R1" }),
    ]);
    await expect(instagramAdapter.refreshToken(fbAccount)).resolves.toMatchObject({ accessToken: "FBLONG2" });
    expect(new URL(requests[0].url).searchParams.get("fb_exchange_token")).toBe("IGLONG");
    await instagramAdapter.replyToComment!(fbAccount, { platformCommentId: "c1", platformPostId: "M1" }, "hi");
    expect(requests[1].url).toBe(`${FB}/c1/replies`);
  });
});

describe("Instagram adapter: error mapping", () => {
  const res = (status: number) => new Response(null, { status });
  it("maps Graph error codes, not just HTTP statuses", () => {
    expect(igError(res(400), { error: { message: "Error validating access token", code: 190 } }, "x")).toMatchObject({ kind: "auth", retryable: false });
    expect(igError(res(400), { error: { message: "limit", code: 9, error_subcode: 2207042 } }, "x")).toMatchObject({ kind: "rate_limit", retryable: false });
    expect(igError(res(400), { error: { message: "too many calls", code: 4 } }, "x")).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(igError(res(400), { error: { message: "try later", code: 9004, is_transient: true } }, "x")).toMatchObject({ retryable: true });
    expect(igError(res(400), { error: { message: "bad", code: 100, error_user_msg: "The aspect ratio is not supported." } }, "x")).toMatchObject({
      kind: "api",
      retryable: false,
      message: expect.stringContaining("aspect ratio"),
    });
  });
});

describe("Instagram adapter: publishing", () => {
  it("publishes one photo as JPEG via ImageKit, waits for the container, and saves progress", async () => {
    const s = igServer({ pollsUntilReady: 1 });
    const { requests } = installFakeFetch([s.handler]);
    const saved: Record<string, unknown>[] = [];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const p = instagramAdapter.publish({ account, content: "Hello #launch", media: [img()], saveState: async (st) => void saved.push(st) });
    await vi.advanceTimersByTimeAsync(10_000);
    const out = await p;

    expect(out).toEqual({ platformPostId: "M1", url: "https://www.instagram.com/p/ABC/" });
    const create = requests.find((r) => r.method === "POST" && r.url === `${API}/1784/media`)!;
    const body = params(create);
    expect(body.caption).toBe("Hello #launch");
    expect(body.access_token).toBe("IGLONG");
    const imageUrl = new URL(body.image_url);
    expect(imageUrl.host).toBe("ik.imagekit.io");
    expect(imageUrl.searchParams.get("tr")).toContain("f-jpg");
    expect(params(requests.find((r) => r.url === `${API}/1784/media_publish`)!).creation_id).toBe("C1");
    expect(saved).toEqual([{ containerId: "C1" }, { containerId: "C1", mediaId: "M1" }]);
  });

  it("publishes a single video as a reel from the original file", async () => {
    const s = igServer();
    installFakeFetch([s.handler]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const p = instagramAdapter.publish({ account, content: "Reel", media: [vid()] });
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    const c = s.containers.get("C1")!.params;
    expect(c.media_type).toBe("REELS");
    expect(c.share_to_feed).toBe("true");
    expect(new URL(c.video_url).searchParams.get("tr")).toBe("orig-true");
  });

  it("builds a carousel from item containers, waiting for each before creating the album", async () => {
    const s = igServer({ pollsUntilReady: 1 });
    installFakeFetch([s.handler]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const p = instagramAdapter.publish({ account, content: "Three", media: [img(1), vid(2), img(3)] });
    await vi.advanceTimersByTimeAsync(60_000);
    await p;
    const [c1, c2, c3, album] = ["C1", "C2", "C3", "C4"].map((id) => s.containers.get(id)!);
    expect([c1, c2, c3].every((c) => c.params.is_carousel_item === "true" && !c.params.caption)).toBe(true);
    expect(c2.params.media_type).toBe("VIDEO");
    expect([c1, c2, c3].every((c) => c.polls >= 2)).toBe(true); // all children FINISHED before the album exists
    expect(album.params).toMatchObject({ media_type: "CAROUSEL", children: "C1,C2,C3", caption: "Three" });
    expect(s.published).toEqual(["C4"]);
  });

  it("resumes a saved container instead of uploading again", async () => {
    const s = igServer({ pollsUntilReady: 0 });
    s.containers.set("C77", { params: {}, polls: 0, status: "IN_PROGRESS" });
    const { requests } = installFakeFetch([s.handler]);
    const out = await instagramAdapter.publish({ account, content: "x", media: [img()], state: { containerId: "C77" } });
    expect(out.platformPostId).toBe("M1");
    expect(requests.some((r) => r.method === "POST" && r.url === `${API}/1784/media`)).toBe(false);
    expect(s.published).toEqual(["C77"]);
  });

  it("never publishes twice: a saved media id short-circuits, and a PUBLISHED container is looked up", async () => {
    const s = igServer();
    const { requests } = installFakeFetch([s.handler]);
    await expect(instagramAdapter.publish({ account, content: "x", media: [img()], state: { containerId: "C1", mediaId: "M1" } })).resolves.toMatchObject({ platformPostId: "M1" });
    expect(requests.every((r) => r.method === "GET")).toBe(true);

    s.containers.set("C5", { params: {}, polls: 0, status: "PUBLISHED" });
    const out = await instagramAdapter.publish({ account, content: "x", media: [img()], state: { containerId: "C5" } });
    expect(out).toEqual({ platformPostId: "M9", url: "https://www.instagram.com/p/LATEST/" });
    expect(s.published).toEqual([]);
  });

  it("an expired saved container is rebuilt", async () => {
    const s = igServer({ pollsUntilReady: 0 });
    s.containers.set("C50", { params: {}, polls: 0, status: "EXPIRED" });
    installFakeFetch([s.handler]);
    const out = await instagramAdapter.publish({ account, content: "x", media: [img()], state: { containerId: "C50" } });
    expect(out.platformPostId).toBe("M1");
    expect(s.published).toEqual(["C1"]);
  });

  it("a processing error is permanent and says why", async () => {
    installFakeFetch([igServer({ pollsUntilReady: 0, failStatus: "ERROR" }).handler]);
    await expect(instagramAdapter.publish({ account, content: "x", media: [vid()] })).rejects.toMatchObject({
      kind: "validation",
      retryable: false,
      message: expect.stringContaining("format is not supported"),
    });
  });

  it("slow processing hands back to the retry loop (retryable) with the container saved", async () => {
    const s = igServer({ neverReady: true });
    installFakeFetch([s.handler]);
    const saved: Record<string, unknown>[] = [];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const p = instagramAdapter.publish({ account, content: "x", media: [vid()], saveState: async (st) => void saved.push(st) });
    const done = expect(p).rejects.toMatchObject({ kind: "api", retryable: true, message: expect.stringContaining("still processing") });
    for (let i = 0; i < 30; i += 1) await vi.advanceTimersByTimeAsync(15_000);
    await done;
    expect(saved).toEqual([{ containerId: "C1" }]);
    expect(s.published).toEqual([]);
  });

  it("rejects posts Instagram cannot take before calling it", async () => {
    const { fake } = installFakeFetch([]);
    await expect(instagramAdapter.publish({ account, content: "text only", media: [] })).rejects.toMatchObject({ kind: "validation" });
    await expect(instagramAdapter.publish({ account, content: "x", media: Array.from({ length: 11 }, (_, i) => img(i)) })).rejects.toMatchObject({ kind: "validation" });
    await expect(instagramAdapter.publish({ account, content: "x", media: [vid(1, 400 * 1024 * 1024)] })).rejects.toMatchObject({ kind: "validation" });
    expect(fake).not.toHaveBeenCalled();
  });
});

describe("Instagram adapter: metrics", () => {
  it("reads likes and comments, and views from insights; a missing insight is unknown, a deleted post is skipped", async () => {
    installFakeFetch([
      (r) => {
        const u = new URL(r.url);
        if (u.pathname === "/v26.0/M1") return json({ like_count: 12, comments_count: 3, id: "M1" });
        if (u.pathname === "/v26.0/M1/insights") return json({ data: [{ name: "views", period: "lifetime", values: [{ value: 340 }] }] });
        if (u.pathname === "/v26.0/M2") return json({ like_count: 1, comments_count: 0 });
        if (u.pathname === "/v26.0/M2/insights") return json({ error: { message: "(#10) Not enough viewers", code: 10 } }, 400);
        if (u.pathname === "/v26.0/GONE") return json({ error: { message: "Object does not exist", code: 100, error_subcode: 33 } }, 400);
        return undefined;
      },
    ]);
    const out = await instagramAdapter.fetchMetrics!(account, ["M1", "M2", "GONE"]);
    expect(out.get("M1")).toEqual({ likes: 12, comments: 3, impressions: 340 });
    expect(out.get("M2")).toEqual({ likes: 1, comments: 0, impressions: null });
    expect(out.has("GONE")).toBe(false);
  });

  it("an expired token stops the sync for this account (auth), it is not swallowed", async () => {
    installFakeFetch([() => json({ error: { message: "Session has expired", code: 190 } }, 400)]);
    await expect(instagramAdapter.fetchMetrics!(account, ["M1"])).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("Instagram adapter: comments", () => {
  const since = new Date("2026-10-01T00:00:00Z");
  function commentsServer(opts: { richFieldsFail?: boolean } = {}) {
    return (r: RecordedRequest) => {
      const u = new URL(r.url);
      if (u.pathname === "/v26.0/1784/media") {
        return json({
          data: [
            { id: "M1", media_type: "IMAGE", media_url: "https://cdn/m1.jpg", permalink: "https://www.instagram.com/p/1/", comments_count: 3 },
            { id: "M2", media_type: "VIDEO", thumbnail_url: "https://cdn/t2.jpg", permalink: "https://www.instagram.com/reel/2/", comments_count: 0 },
          ],
        });
      }
      if (u.pathname === "/v26.0/M1/comments") {
        if (opts.richFieldsFail && u.searchParams.get("fields")!.includes("username")) return json({ error: { message: "(#100) Tried accessing nonexisting field (username)", code: 100 } }, 400);
        return json({
          data: [
            { id: "c1", text: "Love it!", timestamp: "2026-10-20T10:00:00+0000", username: "fan1", like_count: 2, replies: { data: [] } },
            { id: "c2", text: "Where can I buy?", timestamp: "2026-10-21T10:00:00+0000", username: "fan2", replies: { data: [{ id: "r1", username: "asha.makes" }] } },
            { id: "c3", text: "thanks all", timestamp: "2026-10-22T10:00:00+0000", username: "asha.makes" },
            { id: "c0", text: "old", timestamp: "2026-09-01T10:00:00+0000", username: "fan3" },
          ],
        });
      }
      return undefined;
    };
  }

  it("lists comments on recent posts with comments, skipping the owner's own and old ones", async () => {
    const { requests } = installFakeFetch([commentsServer()]);
    const out = await instagramAdapter.fetchComments!(account, { knownPostIds: [], since });
    expect(requests.some((r) => r.url.includes("/M2/comments"))).toBe(false); // no comments, no call
    expect(out.map((c) => c.platformCommentId)).toEqual(["c1", "c2"]);
    expect(out[0]).toMatchObject({
      platformPostId: "M1",
      postUrl: "https://www.instagram.com/p/1/",
      postThumbnailUrl: "https://cdn/m1.jpg",
      authorHandle: "fan1",
      text: "Love it!",
      likeCount: 2,
      ownerReplied: false,
    });
    expect(out[1].ownerReplied).toBe(true); // the owner already answered in the Instagram app
  });

  it("falls back to the documented minimum fields if the richer ones are refused", async () => {
    installFakeFetch([commentsServer({ richFieldsFail: true })]);
    const out = await instagramAdapter.fetchComments!(account, { knownPostIds: [], since });
    expect(out.length).toBeGreaterThan(0);
  });

  it("replies with POST /<comment>/replies", async () => {
    const { requests } = installFakeFetch([() => json({ id: "17890000" })]);
    await expect(instagramAdapter.replyToComment!(account, { platformCommentId: "c1", platformPostId: "M1" }, "Thank you!")).resolves.toEqual({ platformReplyId: "17890000" });
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe(`${API}/c1/replies`);
    expect(params(requests[0])).toMatchObject({ message: "Thank you!", access_token: "IGLONG" });
  });

  it("reports comment access from the granted permissions", () => {
    expect(instagramAdapter.capabilities!({ scopes: "instagram_business_basic,instagram_business_manage_comments" }).comments).toBe(true);
    expect(instagramAdapter.capabilities!({ scopes: "instagram_business_basic" })).toMatchObject({ comments: false, note: expect.stringContaining("Reconnect") });
  });
});
