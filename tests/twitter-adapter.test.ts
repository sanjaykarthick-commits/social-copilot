import { afterEach, describe, expect, it, vi } from "vitest";
import { twitterAdapter, TWITTER_SCOPES } from "@/lib/platforms/twitter";
import { PlatformError, type AdapterAccount } from "@/lib/platforms/types";
import { cdn, installFakeFetch, json } from "./helpers/fake-fetch";

const account: AdapterAccount = {
  id: "acc1",
  platform: "twitter",
  platformAccountId: "42",
  username: "asha",
  displayName: "Asha",
  accessToken: "AT",
  refreshToken: "RT",
  tokenExpiresAt: null,
  scopes: null,
  metadata: {},
};
const basic = "Basic " + Buffer.from("test-x-id:test-x-secret").toString("base64");

afterEach(() => vi.unstubAllGlobals());

describe("X adapter: OAuth", () => {
  it("builds an authorize URL with PKCE S256, offline.access and media.write", () => {
    const url = new URL(twitterAdapter.getAuthUrl({ state: "st", codeChallenge: "CH", redirectUri: "https://app.test/api/oauth/twitter/callback" }));
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe("test-x-id");
    expect(p.get("redirect_uri")).toBe("https://app.test/api/oauth/twitter/callback");
    expect(p.get("code_challenge")).toBe("CH");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("state")).toBe("st");
    expect(p.get("scope")!.split(" ").sort()).toEqual([...TWITTER_SCOPES].sort());
    expect(TWITTER_SCOPES).toEqual(expect.arrayContaining(["offline.access", "tweet.write", "media.write"]));
  });

  it("exchanges the code with Basic auth + verifier, then stores the REAL profile", async () => {
    const { requests } = installFakeFetch([
      (r) => (r.url === "https://api.x.com/2/oauth2/token" ? json({ access_token: "A1", refresh_token: "R1", expires_in: 7200, scope: "tweet.read tweet.write" }) : undefined),
      (r) => (r.url.startsWith("https://api.x.com/2/users/me") ? json({ data: { id: "42", username: "asha", name: "Asha Rao", profile_image_url: "https://pbs.twimg.com/p/abc_normal.jpg" } }) : undefined),
    ]);
    const out = await twitterAdapter.exchangeCode({ code: "CODE", codeVerifier: "VER", redirectUri: "https://app.test/cb" });

    const token = requests[0];
    expect(token.method).toBe("POST");
    expect(token.headers.authorization).toBe(basic);
    expect(token.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(token.body as string);
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: "authorization_code", code: "CODE", code_verifier: "VER", redirect_uri: "https://app.test/cb" });

    expect(requests[1].url).toContain("user.fields=profile_image_url,username,name");
    expect(requests[1].headers.authorization).toBe("Bearer A1");
    expect(out).toMatchObject({
      accessToken: "A1",
      refreshToken: "R1",
      platformAccountId: "42",
      username: "asha",
      displayName: "Asha Rao",
      profileImageUrl: "https://pbs.twimg.com/p/abc_400x400.jpg",
    });
    expect(out.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 7000_000);
  });

  it("maps invalid_grant to a reconnect-required auth error", async () => {
    installFakeFetch([() => json({ error: "invalid_request", error_description: "Value passed for the authorization code was invalid." }, 400)]);
    await expect(twitterAdapter.exchangeCode({ code: "bad", codeVerifier: "v", redirectUri: "r" })).rejects.toMatchObject({ kind: "auth", retryable: false });
  });

  it("refreshes using the refresh token (and returns the rotated one)", async () => {
    const { requests } = installFakeFetch([() => json({ access_token: "A2", refresh_token: "R2", expires_in: 7200 })]);
    const t = await twitterAdapter.refreshToken(account);
    expect(Object.fromEntries(new URLSearchParams(requests[0].body as string))).toMatchObject({ grant_type: "refresh_token", refresh_token: "RT" });
    expect(requests[0].headers.authorization).toBe(basic);
    expect(t).toMatchObject({ accessToken: "A2", refreshToken: "R2" });
  });

  it("fails refresh without a stored refresh token", async () => {
    await expect(twitterAdapter.refreshToken({ ...account, refreshToken: null })).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("X adapter: publishing", () => {
  const tweetOk = () => (r: { url: string }) => (r.url === "https://api.x.com/2/tweets" ? json({ data: { id: "777", text: "hi" } }, 201) : undefined);

  it("posts text and returns the id and a public URL", async () => {
    const { requests } = installFakeFetch([tweetOk()]);
    const out = await twitterAdapter.publish({ account, content: "hello world", media: [] });
    expect(out).toEqual({ platformPostId: "777", url: "https://x.com/asha/status/777" });
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.authorization).toBe("Bearer AT");
    expect(requests[0].body).toEqual({ text: "hello world" });
  });

  it("uploads images via initialize -> append -> finalize and attaches media_ids", async () => {
    const { requests } = installFakeFetch([
      cdn("ik.imagekit.io", { "/t/a.jpg": 1000, "/t/b.png": 2000 }),
      (r) => (r.url.endsWith("/2/media/upload/initialize") ? json({ data: { id: `m${requests.filter((x) => x.url.endsWith("initialize")).length}` } }) : undefined),
      (r) => (/\/media\/upload\/m\d\/append$/.test(r.url) ? new Response(null, { status: 204 }) : undefined),
      (r) => (/\/media\/upload\/m\d\/finalize$/.test(r.url) ? json({ data: { id: "x", size: 1 } }) : undefined),
      tweetOk(),
    ]);
    await twitterAdapter.publish({
      account,
      content: "pics",
      media: [
        { url: "https://ik.imagekit.io/t/a.jpg", type: "image", sizeBytes: 1000 },
        { url: "https://ik.imagekit.io/t/b.png", type: "image", sizeBytes: 2000 },
      ],
    });
    const inits = requests.filter((r) => r.url.endsWith("/initialize"));
    expect(inits.map((r) => r.body)).toEqual([
      { media_type: "image/jpeg", total_bytes: 1000, media_category: "tweet_image" },
      { media_type: "image/png", total_bytes: 2000, media_category: "tweet_image" },
    ]);
    const appends = requests.filter((r) => r.url.endsWith("/append"));
    expect(appends).toHaveLength(2);
    expect(appends[0].body).toEqual({ segment_index: "0", media: "<blob 1000b>" });
    expect(appends[0].headers["content-type"]).toBeUndefined(); // multipart boundary must be set by fetch
    const tweet = requests.find((r) => r.url.endsWith("/2/tweets"))!;
    expect(tweet.body).toEqual({ text: "pics", media: { media_ids: ["m1", "m2"] } });
  });

  it("splits a large file into <=4 MiB, 0-indexed segments", async () => {
    const size = 9 * 1024 * 1024; // 4 + 4 + 1 MiB
    const { requests } = installFakeFetch([
      cdn("ik.imagekit.io", { "/t/v.mp4": size }),
      (r) => (r.url.endsWith("/initialize") ? json({ data: { id: "vid1" } }) : undefined),
      (r) => (r.url.endsWith("/append") ? new Response(null, { status: 204 }) : undefined),
      (r) => (r.url.endsWith("/finalize") ? json({ data: { id: "vid1" } }) : undefined),
      tweetOk(),
    ]);
    await twitterAdapter.publish({ account, content: "", media: [{ url: "https://ik.imagekit.io/t/v.mp4", type: "video", sizeBytes: size }] });
    const appends = requests.filter((r) => r.url.endsWith("/append")).map((r) => r.body as { segment_index: string; media: string });
    expect(appends.map((a) => a.segment_index)).toEqual(["0", "1", "2"]);
    expect(appends.map((a) => a.media)).toEqual([`<blob ${4 * 1024 * 1024}b>`, `<blob ${4 * 1024 * 1024}b>`, `<blob ${1024 * 1024}b>`]);
    expect(requests.find((r) => r.url.endsWith("/initialize"))!.body).toMatchObject({ media_category: "tweet_video", media_type: "video/mp4" });
  });

  it("polls video processing until it succeeds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let polls = 0;
      installFakeFetch([
        cdn("ik.imagekit.io", { "/t/v.mp4": 100 }),
        (r) => (r.url.endsWith("/initialize") ? json({ data: { id: "v9" } }) : undefined),
        (r) => (r.url.endsWith("/append") ? new Response(null, { status: 204 }) : undefined),
        (r) => (r.url.endsWith("/finalize") ? json({ data: { id: "v9", processing_info: { state: "pending", check_after_secs: 1 } } }) : undefined),
        (r) => {
          if (!r.url.includes("command=STATUS")) return undefined;
          polls += 1;
          return json({ data: { processing_info: polls < 2 ? { state: "in_progress", check_after_secs: 1 } : { state: "succeeded" } } });
        },
        tweetOk(),
      ]);
      const p = twitterAdapter.publish({ account, content: "v", media: [{ url: "https://ik.imagekit.io/t/v.mp4", type: "video", sizeBytes: 100 }] });
      await vi.advanceTimersByTimeAsync(5000);
      await expect(p).resolves.toMatchObject({ platformPostId: "777" });
      expect(polls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a media processing failure as a permanent validation error", async () => {
    installFakeFetch([
      cdn("ik.imagekit.io", { "/t/v.mp4": 100 }),
      (r) => (r.url.endsWith("/initialize") ? json({ data: { id: "v9" } }) : undefined),
      (r) => (r.url.endsWith("/append") ? new Response(null, { status: 204 }) : undefined),
      (r) => (r.url.endsWith("/finalize") ? json({ data: { id: "v9", processing_info: { state: "failed", error: { message: "InvalidMedia" } } } }) : undefined),
    ]);
    await expect(
      twitterAdapter.publish({ account, content: "v", media: [{ url: "https://ik.imagekit.io/t/v.mp4", type: "video", sizeBytes: 100 }] }),
    ).rejects.toMatchObject({ kind: "validation", retryable: false, message: expect.stringContaining("InvalidMedia") });
  });

  it("rejects what X cannot post before calling the API", async () => {
    const { fake } = installFakeFetch([]);
    const img = { url: "https://ik.imagekit.io/t/a.jpg", type: "image" as const, sizeBytes: 10 };
    const vid = { url: "https://ik.imagekit.io/t/v.mp4", type: "video" as const, sizeBytes: 10 };
    await expect(twitterAdapter.publish({ account, content: "x", media: [img, vid] })).rejects.toMatchObject({ kind: "validation" });
    await expect(twitterAdapter.publish({ account, content: "x", media: [vid, vid] })).rejects.toMatchObject({ kind: "validation" });
    await expect(twitterAdapter.publish({ account, content: "x", media: [img, img, img, img, img] })).rejects.toMatchObject({ kind: "validation" });
    await expect(twitterAdapter.publish({ account, content: "  ", media: [] })).rejects.toMatchObject({ kind: "validation" });
    expect(fake).not.toHaveBeenCalled();
  });

  it("rejects images over X's 5 MB limit", async () => {
    installFakeFetch([]);
    await expect(
      twitterAdapter.publish({ account, content: "x", media: [{ url: "https://ik.imagekit.io/t/a.jpg", type: "image", sizeBytes: 6 * 1024 * 1024 }] }),
    ).rejects.toMatchObject({ kind: "validation", message: expect.stringContaining("5 MB") });
  });

  describe("error mapping", () => {
    const publish = () => twitterAdapter.publish({ account, content: "hello", media: [] });
    it("401 -> reconnect (auth, not retryable)", async () => {
      installFakeFetch([() => json({ title: "Unauthorized", detail: "Unauthorized" }, 401)]);
      await expect(publish()).rejects.toMatchObject({ kind: "auth", retryable: false, status: 401 });
    });
    it("429 -> rate limit, retryable", async () => {
      installFakeFetch([() => json({ title: "Too Many Requests", detail: "Too Many Requests" }, 429)]);
      await expect(publish()).rejects.toMatchObject({ kind: "rate_limit", retryable: true });
    });
    it("5xx -> retryable", async () => {
      installFakeFetch([() => json({ detail: "oops" }, 503)]);
      await expect(publish()).rejects.toMatchObject({ retryable: true });
    });
    it("403 duplicate -> a friendly permanent message", async () => {
      installFakeFetch([() => json({ title: "Forbidden", detail: "You are not allowed to create a Tweet with duplicate content." }, 403)]);
      await expect(publish()).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("duplicate post") });
    });
    it("402/403 plan problems surface X's own message so the user can act on it", async () => {
      installFakeFetch([() => json({ title: "CreditsDepleted", detail: "Your enrolled account does not have any credits to fulfill this request." }, 402)]);
      await expect(publish()).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("credits") });
    });
    it("network failure -> retryable", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
      const err = await publish().catch((e) => e);
      expect(err).toBeInstanceOf(PlatformError);
      expect(err).toMatchObject({ kind: "api", retryable: true });
    });
    it("a 201 without an id is an error, not a silent success", async () => {
      installFakeFetch([() => json({ data: {} }, 201)]);
      await expect(publish()).rejects.toMatchObject({ kind: "api" });
    });
  });
});

describe("X adapter: metrics", () => {
  it("requests public_metrics for up to 100 ids per call and maps the fields", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => String(1000 + i));
    const { requests } = installFakeFetch([
      (r) => {
        if (!r.url.startsWith("https://api.x.com/2/tweets?ids=")) return undefined;
        const asked = new URL(r.url).searchParams.get("ids")!.split(",");
        return json({ data: asked.map((id) => ({ id, public_metrics: { like_count: 3, reply_count: 1, impression_count: 50, repost_count: 9 } })) });
      },
    ]);
    const out = await twitterAdapter.fetchMetrics!(account, ids);
    expect(requests).toHaveLength(2);
    expect(new URL(requests[0].url).searchParams.get("ids")!.split(",")).toHaveLength(100);
    expect(new URL(requests[0].url).searchParams.get("post.fields")).toBe("public_metrics");
    expect(requests[0].headers.authorization).toBe("Bearer AT");
    expect(out.size).toBe(150);
    expect(out.get("1000")).toEqual({ likes: 3, comments: 1, impressions: 50 });
  });
  it("reports fields X omits as null, not zero", async () => {
    installFakeFetch([() => json({ data: [{ id: "1", public_metrics: { like_count: 4 } }] })]);
    expect((await twitterAdapter.fetchMetrics!(account, ["1"])).get("1")).toEqual({ likes: 4, comments: null, impressions: null });
  });
  it("surfaces access problems as errors instead of returning empty data", async () => {
    installFakeFetch([() => json({ title: "Forbidden", detail: "Your account does not have read access." }, 403)]);
    await expect(twitterAdapter.fetchMetrics!(account, ["1"])).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("read access") });
  });
});
