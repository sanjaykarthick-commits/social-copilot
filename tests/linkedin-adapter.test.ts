import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { linkedinAdapter, LINKEDIN_DEFAULT_VERSION, toLittleText } from "@/lib/platforms/linkedin";
import type { AdapterAccount } from "@/lib/platforms/types";
import { cdn, installFakeFetch, json, type RecordedRequest } from "./helpers/fake-fetch";

const account: AdapterAccount = {
  id: "acc-li",
  platform: "linkedin",
  platformAccountId: "abc123",
  username: null,
  displayName: "Asha Rao",
  accessToken: "LIAT",
  refreshToken: null,
  tokenExpiresAt: null,
  scopes: "openid,profile,w_member_social",
  metadata: {},
};
const approved: AdapterAccount = { ...account, scopes: "openid,profile,w_member_social,r_member_social,r_member_postAnalytics" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  resetEnvCache();
});

const REST = "https://api.linkedin.com/rest";
const MiB = 1024 * 1024;
const form = (r: RecordedRequest) => Object.fromEntries(new URLSearchParams(r.body as string));

function liServer(opts: { videoStatuses?: (string | 403)[]; postStatus?: number; postBody?: unknown } = {}) {
  const statuses = [...(opts.videoStatuses ?? ["AVAILABLE"])];
  const puts: RecordedRequest[] = [];
  let images = 0;
  const handler = (r: RecordedRequest) => {
    const u = new URL(r.url);
    if (r.method === "POST" && r.url === `${REST}/images?action=initializeUpload`) {
      images += 1;
      return json({ value: { uploadUrlExpiresAt: 1, uploadUrl: `https://www.linkedin.com/dms-uploads/IMG${images}/uploaded-image/0?ut=x`, image: `urn:li:image:IMG${images}` } });
    }
    if (r.method === "POST" && r.url === `${REST}/videos?action=initializeUpload`) {
      const size = (r.body as { initializeUploadRequest: { fileSizeBytes: number } }).initializeUploadRequest.fileSizeBytes;
      const parts = [];
      for (let first = 0, i = 0; first < size; first += 4 * MiB, i += 1) parts.push({ uploadUrl: `https://www.linkedin.com/dms-uploads/V1/part${i}`, firstByte: first, lastByte: Math.min(first + 4 * MiB, size) - 1 });
      return json({ value: { video: "urn:li:video:V1", uploadToken: "TOK", uploadInstructions: parts, uploadUrlsExpireAt: 1 } });
    }
    if (r.method === "PUT" && u.host === "www.linkedin.com") {
      puts.push(r);
      const part = u.pathname.match(/part(\d+)$/)?.[1];
      return new Response(null, { status: part ? 200 : 201, headers: part ? { etag: `etag-${part}` } : {} });
    }
    if (r.method === "POST" && r.url === `${REST}/videos?action=finalizeUpload`) return new Response(null, { status: 200 });
    if (r.method === "GET" && r.url === `${REST}/videos/${encodeURIComponent("urn:li:video:V1")}`) {
      const s = statuses.length > 1 ? statuses.shift()! : statuses[0];
      if (s === 403) return json({ message: "Not enough permissions to access: videos.GET", status: 403 }, 403);
      return json({ id: "urn:li:video:V1", status: s, ...(s === "PROCESSING_FAILED" ? { processingFailureReason: "Unsupported codec" } : {}) });
    }
    if (r.method === "POST" && r.url === `${REST}/posts`) {
      if (opts.postStatus) return json(opts.postBody ?? {}, opts.postStatus);
      return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:999" } });
    }
    return undefined;
  };
  return { handler, puts };
}

describe("LinkedIn adapter: OAuth", () => {
  it("requests only self-serve scopes by default, and approved extras when configured", () => {
    const url = new URL(linkedinAdapter.getAuthUrl({ state: "st", codeChallenge: "CH", redirectUri: "https://app.test/api/oauth/linkedin/callback" }));
    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(url.searchParams.get("scope")).toBe("openid profile w_member_social");
    expect(url.searchParams.get("client_id")).toBe("test-li-id");
    expect(url.searchParams.get("response_type")).toBe("code");

    vi.stubEnv("LINKEDIN_EXTRA_SCOPES", "r_member_social, r_member_postAnalytics bad-scope!");
    resetEnvCache();
    const extra = new URL(linkedinAdapter.getAuthUrl({ state: "st", codeChallenge: "CH", redirectUri: "r" })).searchParams.get("scope");
    expect(extra).toBe("openid profile w_member_social r_member_social r_member_postAnalytics");
  });

  it("exchanges the code (secret in the form body) and identifies the member by OpenID sub", async () => {
    const { requests } = installFakeFetch([
      (r) => (r.url === "https://www.linkedin.com/oauth/v2/accessToken" ? json({ access_token: "LIAT", expires_in: 5_184_000, scope: "openid,profile,w_member_social" }) : undefined),
      (r) => (r.url === "https://api.linkedin.com/v2/userinfo" ? json({ sub: "abc123", name: "Asha Rao", picture: "https://media.licdn.com/p.jpg" }) : undefined),
    ]);
    const out = await linkedinAdapter.exchangeCode({ code: "C", codeVerifier: "unused", redirectUri: "https://app.test/cb" });
    expect(form(requests[0])).toEqual({ grant_type: "authorization_code", code: "C", redirect_uri: "https://app.test/cb", client_id: "test-li-id", client_secret: "test-li-secret" });
    expect(requests[1].headers.authorization).toBe("Bearer LIAT");
    expect(out).toMatchObject({ accessToken: "LIAT", refreshToken: null, platformAccountId: "abc123", username: null, displayName: "Asha Rao", profileImageUrl: "https://media.licdn.com/p.jpg", scopes: "openid,profile,w_member_social" });
  });

  it("cannot renew without a partner refresh token: says to reconnect, without calling LinkedIn", async () => {
    const { fake } = installFakeFetch([]);
    expect(linkedinAdapter.canRefresh!({ refreshToken: null })).toBe(false);
    await expect(linkedinAdapter.refreshToken(account)).rejects.toMatchObject({ kind: "auth", message: expect.stringContaining("Reconnect LinkedIn") });
    expect(fake).not.toHaveBeenCalled();
  });

  it("uses a refresh token when LinkedIn issued one", async () => {
    const { requests } = installFakeFetch([() => json({ access_token: "NEW", expires_in: 100, refresh_token: "R2" })]);
    expect(linkedinAdapter.canRefresh!({ refreshToken: "R" })).toBe(true);
    await expect(linkedinAdapter.refreshToken({ ...account, refreshToken: "R" })).resolves.toMatchObject({ accessToken: "NEW", refreshToken: "R2" });
    expect(form(requests[0])).toMatchObject({ grant_type: "refresh_token", refresh_token: "R" });
  });
});

describe("LinkedIn adapter: little text format", () => {
  it("escapes every reserved character but keeps hashtags working", () => {
    expect(toLittleText("Ship it (v2) @team *now* #launch #2026 C# a_b ~x~ [1] {y} <z> | \\")).toBe(
      "Ship it \\(v2\\) \\@team \\*now\\* #launch #2026 C\\# a\\_b \\~x\\~ \\[1\\] \\{y\\} \\<z\\> \\| \\\\",
    );
    expect(toLittleText("#start of line")).toBe("#start of line");
    expect(toLittleText("lonely # sign")).toBe("lonely \\# sign");
  });
});

describe("LinkedIn adapter: publishing", () => {
  it("posts text to the member's profile with the versioned headers", async () => {
    const s = liServer();
    const { requests } = installFakeFetch([s.handler]);
    const out = await linkedinAdapter.publish({ account, content: "Hello (world) #news", media: [] });
    expect(out).toEqual({ platformPostId: "urn:li:share:999", url: "https://www.linkedin.com/feed/update/urn:li:share:999/" });
    const post = requests.find((r) => r.url === `${REST}/posts`)!;
    expect(post.headers["linkedin-version"]).toBe(LINKEDIN_DEFAULT_VERSION);
    expect(post.headers["x-restli-protocol-version"]).toBe("2.0.0");
    expect(post.headers.authorization).toBe("Bearer LIAT");
    expect(post.body).toEqual({
      author: "urn:li:person:abc123",
      commentary: "Hello \\(world\\) #news",
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    });
  });

  it("uploads one photo (owner = the member) and attaches it", async () => {
    const s = liServer();
    const { requests } = installFakeFetch([cdn("ik.imagekit.io", { "/t/a.jpg": 2000 }), s.handler]);
    await linkedinAdapter.publish({ account, content: "Pic", media: [{ url: "https://ik.imagekit.io/t/a.jpg", type: "image", sizeBytes: 2000 }] });
    expect(requests.find((r) => r.url.includes("images?action=initializeUpload"))!.body).toEqual({ initializeUploadRequest: { owner: "urn:li:person:abc123" } });
    expect(s.puts[0].bodyBytes).toBe(2000);
    expect(s.puts[0].headers.authorization).toBe("Bearer LIAT");
    expect((requests.find((r) => r.url === `${REST}/posts`)!.body as { content: unknown }).content).toEqual({ media: { id: "urn:li:image:IMG1" } });
  });

  it("several photos become a multiImage post; WebP is converted to JPEG by ImageKit first", async () => {
    const s = liServer();
    const { requests } = installFakeFetch([
      (r) => (new URL(r.url).host === "ik.imagekit.io" ? new Response(new Uint8Array(10), { status: 200 }) : undefined),
      s.handler,
    ]);
    await linkedinAdapter.publish({
      account,
      content: "Two",
      media: [
        { url: "https://ik.imagekit.io/t/a.jpg", type: "image" },
        { url: "https://ik.imagekit.io/t/b.webp", type: "image" },
      ],
    });
    const downloads = requests.filter((r) => new URL(r.url).host === "ik.imagekit.io").map((r) => new URL(r.url));
    expect(downloads[0].searchParams.has("tr")).toBe(false);
    expect(downloads[1].searchParams.get("tr")).toBe("f-jpg");
    expect((requests.find((r) => r.url === `${REST}/posts`)!.body as { content: unknown }).content).toEqual({
      multiImage: { images: [{ id: "urn:li:image:IMG1" }, { id: "urn:li:image:IMG2" }] },
    });
  });

  it("uploads a video in the parts LinkedIn asks for, finalizes with the ETags in order, waits until it is available", async () => {
    const size = 9 * MiB;
    const s = liServer({ videoStatuses: ["PROCESSING", "AVAILABLE"] });
    const { requests } = installFakeFetch([cdn("ik.imagekit.io", { "/t/v.mp4": size }), s.handler]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const p = linkedinAdapter.publish({ account, content: "Watch", media: [{ url: "https://ik.imagekit.io/t/v.mp4", type: "video", sizeBytes: size }] });
    await vi.advanceTimersByTimeAsync(10_000);
    await p;

    expect(s.puts.map((r) => r.bodyBytes)).toEqual([4 * MiB, 4 * MiB, 1 * MiB]);
    expect(requests.find((r) => r.url.includes("finalizeUpload"))!.body).toEqual({
      finalizeUploadRequest: { video: "urn:li:video:V1", uploadToken: "TOK", uploadedPartIds: ["etag-0", "etag-1", "etag-2"] },
    });
    const order = requests.map((r) => (r.url.includes("/videos/urn") ? "status" : r.url === `${REST}/posts` ? "post" : null)).filter(Boolean);
    expect(order).toEqual(["status", "status", "post"]);
    expect((requests.find((r) => r.url === `${REST}/posts`)!.body as { content: unknown }).content).toEqual({ media: { id: "urn:li:video:V1" } });
  });

  it("posts anyway if the token may not read video status (403), and fails clearly if processing failed", async () => {
    const size = MiB;
    installFakeFetch([cdn("ik.imagekit.io", { "/t/v.mp4": size }), liServer({ videoStatuses: [403] }).handler]);
    await expect(linkedinAdapter.publish({ account, content: "x", media: [{ url: "https://ik.imagekit.io/t/v.mp4", type: "video", sizeBytes: size }] })).resolves.toMatchObject({
      platformPostId: "urn:li:share:999",
    });

    installFakeFetch([cdn("ik.imagekit.io", { "/t/v.mp4": size }), liServer({ videoStatuses: ["PROCESSING_FAILED"] }).handler]);
    await expect(linkedinAdapter.publish({ account, content: "x", media: [{ url: "https://ik.imagekit.io/t/v.mp4", type: "video", sizeBytes: size }] })).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining("Unsupported codec"),
    });
  });

  it("a retry reuses uploads saved by the previous attempt", async () => {
    const s = liServer();
    const { requests } = installFakeFetch([s.handler]);
    const saved: unknown[] = [];
    await linkedinAdapter.publish({
      account,
      content: "Again",
      media: [{ url: "https://ik.imagekit.io/t/a.jpg", type: "image" }],
      state: { assets: ["urn:li:image:OLD"] },
      saveState: async (st) => void saved.push(st),
    });
    expect(requests.some((r) => r.url.includes("initializeUpload"))).toBe(false);
    expect((requests.find((r) => r.url === `${REST}/posts`)!.body as { content: unknown }).content).toEqual({ media: { id: "urn:li:image:OLD" } });
    expect(saved).toEqual([]);
  });

  it("an unconfirmed post (network drop) is NOT retried automatically: it could post twice", async () => {
    installFakeFetch([
      (r) => {
        if (r.url === `${REST}/posts`) throw new Error("socket hang up");
        return undefined;
      },
    ]);
    await expect(linkedinAdapter.publish({ account, content: "x", media: [] })).rejects.toMatchObject({ kind: "api", retryable: false, message: expect.stringContaining("Check your profile") });
  });

  it("explains duplicates, maps 401 to reconnect and 429 to retry", async () => {
    installFakeFetch([liServer({ postStatus: 422, postBody: { message: "Content is a duplicate of urn:li:share:1", status: 422 } }).handler]);
    await expect(linkedinAdapter.publish({ account, content: "x", media: [] })).rejects.toMatchObject({ message: expect.stringContaining("duplicate of a recent post") });
    installFakeFetch([liServer({ postStatus: 401, postBody: { message: "Invalid access token", status: 401 } }).handler]);
    await expect(linkedinAdapter.publish({ account, content: "x", media: [] })).rejects.toMatchObject({ kind: "auth" });
    installFakeFetch([liServer({ postStatus: 429, postBody: { message: "Too many requests", status: 429 } }).handler]);
    await expect(linkedinAdapter.publish({ account, content: "x", media: [] })).rejects.toMatchObject({ kind: "rate_limit", retryable: true });
  });

  it("rejects mixed media and empty posts before calling LinkedIn", async () => {
    const { fake } = installFakeFetch([]);
    const img = { url: "https://ik.imagekit.io/t/a.jpg", type: "image" as const };
    const vid = { url: "https://ik.imagekit.io/t/v.mp4", type: "video" as const };
    await expect(linkedinAdapter.publish({ account, content: "x", media: [img, vid] })).rejects.toMatchObject({ kind: "validation" });
    await expect(linkedinAdapter.publish({ account, content: "x", media: [vid, vid] })).rejects.toMatchObject({ kind: "validation" });
    await expect(linkedinAdapter.publish({ account, content: "  ", media: [] })).rejects.toMatchObject({ kind: "validation" });
    expect(fake).not.toHaveBeenCalled();
  });
});

describe("LinkedIn adapter: stats and comments need LinkedIn's approval", () => {
  it("reports what this connection can do from its granted scopes", () => {
    expect(linkedinAdapter.capabilities!(account)).toMatchObject({ metrics: false, comments: false, note: expect.stringContaining("approved") });
    expect(linkedinAdapter.capabilities!(approved)).toEqual({ metrics: true, comments: true, note: undefined });
  });

  it("without r_member_postAnalytics nothing is requested; with it, impressions/reactions/comments per post", async () => {
    const { fake } = installFakeFetch([]);
    expect((await linkedinAdapter.fetchMetrics!(account, ["urn:li:share:1"])).size).toBe(0);
    expect(fake).not.toHaveBeenCalled();

    const { requests } = installFakeFetch([
      (r) => {
        const u = new URL(r.url);
        if (u.pathname !== "/rest/memberCreatorPostAnalytics") return undefined;
        const counts: Record<string, number> = { IMPRESSION: 500, REACTION: 20, COMMENT: 4 };
        return json({ elements: [{ count: counts[u.searchParams.get("queryType")!], metricType: u.searchParams.get("queryType") }], paging: {} });
      },
    ]);
    const out = await linkedinAdapter.fetchMetrics!(approved, ["urn:li:share:1", "urn:li:ugcPost:2"]);
    expect(out.get("urn:li:share:1")).toEqual({ likes: 20, comments: 4, impressions: 500 });
    expect(requests[0].url).toContain("q=entity&entity=(share:urn%3Ali%3Ashare%3A1)&queryType=IMPRESSION&aggregation=TOTAL");
    expect(requests.some((r) => r.url.includes("entity=(ugc:urn%3Ali%3AugcPost%3A2)"))).toBe(true);
  });

  it("reads comments on our posts only when allowed, skipping the member's own", async () => {
    const { fake } = installFakeFetch([]);
    expect(await linkedinAdapter.fetchComments!(account, { knownPostIds: ["urn:li:share:1"], since: new Date(0) })).toEqual([]);
    expect(fake).not.toHaveBeenCalled();

    const { requests } = installFakeFetch([
      () =>
        json({
          elements: [
            { id: "11", commentUrn: "urn:li:comment:(urn:li:activity:5,11)", actor: "urn:li:person:zzz", object: "urn:li:activity:5", created: { time: Date.parse("2026-10-20T00:00:00Z") }, message: { text: "Great post" }, likesSummary: { totalLikes: 3 } },
            { id: "12", commentUrn: "urn:li:comment:(urn:li:activity:5,12)", actor: "urn:li:person:abc123", object: "urn:li:activity:5", created: { time: Date.parse("2026-10-21T00:00:00Z") }, message: { text: "Thanks!" } },
          ],
        }),
    ]);
    const out = await linkedinAdapter.fetchComments!(approved, { knownPostIds: ["urn:li:share:1"], since: new Date("2026-10-01T00:00:00Z") });
    expect(requests[0].url).toBe(`${REST}/socialActions/${encodeURIComponent("urn:li:share:1")}/comments?count=50`);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ platformCommentId: "urn:li:comment:(urn:li:activity:5,11)", platformPostId: "urn:li:share:1", text: "Great post", likeCount: 3, extra: { object: "urn:li:activity:5" } });
  });

  it("replies as the member, nested under the comment", async () => {
    const { requests } = installFakeFetch([() => json({ commentUrn: "urn:li:comment:(urn:li:activity:5,99)", id: "99" }, 201)]);
    const commentUrn = "urn:li:comment:(urn:li:activity:5,11)";
    const out = await linkedinAdapter.replyToComment!(approved, { platformCommentId: commentUrn, platformPostId: "urn:li:share:1", extra: { object: "urn:li:activity:5" } }, "Thank you!");
    expect(out.platformReplyId).toBe("urn:li:comment:(urn:li:activity:5,99)");
    expect(requests[0].url).toBe(`${REST}/socialActions/${encodeURIComponent(commentUrn)}/comments`);
    expect(requests[0].body).toEqual({ actor: "urn:li:person:abc123", object: "urn:li:activity:5", message: { text: "Thank you!" }, parentComment: commentUrn });
  });
});
