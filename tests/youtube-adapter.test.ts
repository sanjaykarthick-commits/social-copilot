import { afterEach, describe, expect, it, vi } from "vitest";
import { youtubeAdapter, YOUTUBE_SCOPES } from "@/lib/platforms/youtube";
import type { AdapterAccount } from "@/lib/platforms/types";
import { cdn, installFakeFetch, json, type RecordedRequest } from "./helpers/fake-fetch";

const account: AdapterAccount = {
  id: "acc2",
  platform: "youtube",
  platformAccountId: "UC123",
  username: "asha",
  displayName: "Asha's Channel",
  accessToken: "GAT",
  refreshToken: "GRT",
  tokenExpiresAt: null,
  scopes: null,
  metadata: {},
};

afterEach(() => vi.unstubAllGlobals());

const MiB = 1024 * 1024;
const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=SESS";
const video = (size: number) => ({ url: "https://ik.imagekit.io/t/v.mp4", type: "video" as const, sizeBytes: size });

describe("YouTube adapter: OAuth", () => {
  it("requests offline access with forced consent, PKCE and the upload + readonly scopes", () => {
    const url = new URL(youtubeAdapter.getAuthUrl({ state: "st", codeChallenge: "CH", redirectUri: "https://app.test/api/oauth/youtube/callback" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = url.searchParams;
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("client_id")).toBe("test-g-id");
    expect(p.get("scope")!.split(" ")).toEqual(YOUTUBE_SCOPES);
    expect(YOUTUBE_SCOPES).toContain("https://www.googleapis.com/auth/youtube.upload");
  });

  it("exchanges the code (client secret + verifier in the body) and stores the real channel", async () => {
    const { requests } = installFakeFetch([
      (r) => (r.url === "https://oauth2.googleapis.com/token" ? json({ access_token: "GA", refresh_token: "GR", expires_in: 3599, scope: "x" }) : undefined),
      (r) =>
        r.url.startsWith("https://www.googleapis.com/youtube/v3/channels")
          ? json({ items: [{ id: "UC123", snippet: { title: "Asha's Channel", customUrl: "@ashachan", thumbnails: { default: { url: "d.jpg" }, high: { url: "https://yt3.ggpht.com/h.jpg" } } } }] })
          : undefined,
    ]);
    const out = await youtubeAdapter.exchangeCode({ code: "C", codeVerifier: "V", redirectUri: "https://app.test/cb" });
    expect(Object.fromEntries(new URLSearchParams(requests[0].body as string))).toMatchObject({
      grant_type: "authorization_code",
      code: "C",
      code_verifier: "V",
      client_id: "test-g-id",
      client_secret: "test-g-secret",
    });
    expect(requests[1].url).toContain("mine=true");
    expect(out).toMatchObject({ platformAccountId: "UC123", username: "ashachan", displayName: "Asha's Channel", profileImageUrl: "https://yt3.ggpht.com/h.jpg", refreshToken: "GR" });
  });

  it("refuses a connection that has no refresh token (it would die in an hour)", async () => {
    installFakeFetch([() => json({ access_token: "GA", expires_in: 3599 })]);
    await expect(youtubeAdapter.exchangeCode({ code: "C", codeVerifier: "V", redirectUri: "r" })).rejects.toMatchObject({
      kind: "auth",
      message: expect.stringContaining("offline access"),
    });
  });

  it("explains when the Google account has no YouTube channel", async () => {
    installFakeFetch([
      (r) => (r.url.includes("oauth2.googleapis.com") ? json({ access_token: "GA", refresh_token: "GR", expires_in: 3599 }) : undefined),
      () => json({ items: [] }),
    ]);
    await expect(youtubeAdapter.exchangeCode({ code: "C", codeVerifier: "V", redirectUri: "r" })).rejects.toMatchObject({ kind: "validation", message: expect.stringContaining("no YouTube channel") });
  });

  it("refresh keeps the old refresh token (Google does not re-issue it)", async () => {
    const { requests } = installFakeFetch([() => json({ access_token: "GA2", expires_in: 3599 })]);
    const t = await youtubeAdapter.refreshToken(account);
    expect(Object.fromEntries(new URLSearchParams(requests[0].body as string))).toMatchObject({ grant_type: "refresh_token", refresh_token: "GRT" });
    expect(t.accessToken).toBe("GA2");
    expect(t.refreshToken).toBeNull(); // caller keeps the stored one
  });

  it("a revoked refresh token means reconnect", async () => {
    installFakeFetch([() => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400)]);
    await expect(youtubeAdapter.refreshToken(account)).rejects.toMatchObject({ kind: "auth", retryable: false });
  });
});

describe("YouTube adapter: resumable upload", () => {
  function server(opts: { size: number; failFirstPutWithNetworkError?: boolean; flaky503Once?: boolean }) {
    let received = 0;
    let failed = false;
    let flaked = false;
    const puts: RecordedRequest[] = [];
    const handlers = [
      cdn("ik.imagekit.io", { "/t/v.mp4": opts.size }),
      (r: RecordedRequest) =>
        r.method === "POST" && r.url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable")
          ? new Response(null, { status: 200, headers: { location: SESSION } })
          : undefined,
      (r: RecordedRequest) => {
        if (r.method !== "PUT" || r.url !== SESSION) return undefined;
        puts.push(r);
        const range = r.headers["content-range"];
        if (range.startsWith("bytes */")) {
          return received === 0 ? new Response(null, { status: 308 }) : new Response(null, { status: 308, headers: { range: `bytes=0-${received - 1}` } });
        }
        const m = range.match(/bytes (\d+)-(\d+)\/(\d+)/)!;
        const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
        if (opts.flaky503Once && !flaked && start > 0) {
          flaked = true;
          return json({ error: { message: "backend error" } }, 503);
        }
        if (start !== received) return json({ error: { message: `bad offset ${start} != ${received}` } }, 400);
        received = end + 1;
        if (received >= total) return json({ id: "VID123", status: { privacyStatus: "public" } }, 201);
        return new Response(null, { status: 308, headers: { range: `bytes=0-${received - 1}` } });
      },
    ];
    return { handlers, puts, get received() { return received; }, failFirst: () => !failed && (failed = true) };
  }

  it("starts a session with the right headers and metadata, then uploads in 8 MiB chunks", async () => {
    const s = server({ size: 20 * MiB });
    const { requests } = installFakeFetch(s.handlers);
    const out = await youtubeAdapter.publish({ account, content: "My launch video\nAll the details here.", media: [video(20 * MiB)], asVideo: true });
    expect(out).toEqual({ platformPostId: "VID123", url: "https://www.youtube.com/watch?v=VID123" });

    const start = requests.find((r) => r.method === "POST" && r.url.includes("uploadType=resumable"))!;
    expect(start.url).toContain("part=snippet,status");
    expect(start.headers.authorization).toBe("Bearer GAT");
    expect(start.headers["x-upload-content-length"]).toBe(String(20 * MiB));
    expect(start.headers["x-upload-content-type"]).toBe("video/mp4");
    expect(start.body).toMatchObject({
      snippet: { title: "My launch video", description: "My launch video\nAll the details here." },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
    });

    // 8 MiB multiples for every non-final chunk; the last is whatever remains.
    expect(s.puts.map((p) => p.headers["content-range"])).toEqual([
      `bytes 0-${8 * MiB - 1}/${20 * MiB}`,
      `bytes ${8 * MiB}-${16 * MiB - 1}/${20 * MiB}`,
      `bytes ${16 * MiB}-${20 * MiB - 1}/${20 * MiB}`,
    ]);
    expect(s.puts.every((p) => p.headers["content-type"] === "video/mp4")).toBe(true);
    expect(s.puts.slice(0, -1).every((p) => p.bodyBytes! % (256 * 1024) === 0)).toBe(true);
  });

  it("uploads a small file in one request", async () => {
    const s = server({ size: 1 * MiB });
    installFakeFetch(s.handlers);
    await youtubeAdapter.publish({ account, content: "Tiny", media: [video(1 * MiB)], asVideo: true });
    expect(s.puts).toHaveLength(1);
    expect(s.puts[0].headers["content-range"]).toBe(`bytes 0-${MiB - 1}/${MiB}`);
  });

  it("resumes from the server's offset after a dropped connection instead of restarting", async () => {
    const s = server({ size: 20 * MiB });
    let dropped = false;
    const { requests } = installFakeFetch([
      (r) => {
        // Drop the 2nd chunk's connection once.
        if (r.method === "PUT" && r.headers["content-range"]?.startsWith(`bytes ${8 * MiB}-`) && !dropped) {
          dropped = true;
          throw new Error("ECONNRESET");
        }
        return undefined;
      },
      ...s.handlers,
    ]);
    const out = await youtubeAdapter.publish({ account, content: "Resume me", media: [video(20 * MiB)], asVideo: true });
    expect(out.platformPostId).toBe("VID123");
    const ranges = requests.filter((r) => r.method === "PUT").map((r) => r.headers["content-range"]);
    expect(ranges).toContain(`bytes */${20 * MiB}`); // status query
    // after the query the upload continued at 8 MiB, not at 0
    expect(ranges.filter((r) => r.startsWith("bytes 0-"))).toHaveLength(1);
  });

  it("recovers from a transient 503 mid-upload", async () => {
    const s = server({ size: 20 * MiB, flaky503Once: true });
    installFakeFetch(s.handlers);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const p = youtubeAdapter.publish({ account, content: "Flaky", media: [video(20 * MiB)], asVideo: true });
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(p).resolves.toMatchObject({ platformPostId: "VID123" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("strips < and > from the title/description (YouTube rejects them)", async () => {
    const s = server({ size: MiB });
    const { requests } = installFakeFetch(s.handlers);
    await youtubeAdapter.publish({ account, content: "A <b>bold</b> title\nbody", media: [video(MiB)], asVideo: true });
    const body = requests.find((r) => r.url.includes("uploadType=resumable"))!.body as { snippet: { title: string; description: string } };
    expect(body.snippet.title).toBe("A bbold/b title");
    expect(body.snippet.description).not.toMatch(/[<>]/);
  });

  it("refuses to publish without 'post as video', without a video, or without a title", async () => {
    const { fake } = installFakeFetch([]);
    await expect(youtubeAdapter.publish({ account, content: "t", media: [video(10)], asVideo: false })).rejects.toMatchObject({ kind: "validation" });
    await expect(youtubeAdapter.publish({ account, content: "t", media: [], asVideo: true })).rejects.toMatchObject({ kind: "validation" });
    await expect(youtubeAdapter.publish({ account, content: "t", media: [video(10), video(10)], asVideo: true })).rejects.toMatchObject({ kind: "validation" });
    await expect(youtubeAdapter.publish({ account, content: "   ", media: [video(10)], asVideo: true })).rejects.toMatchObject({ kind: "validation" });
    expect(fake).not.toHaveBeenCalled();
  });

  it("401 means reconnect; a quota error is a permanent, explained failure", async () => {
    installFakeFetch([() => json({ error: { message: "Invalid Credentials" } }, 401)]);
    await expect(youtubeAdapter.publish({ account, content: "t", media: [video(10)], asVideo: true })).rejects.toMatchObject({ kind: "auth", retryable: false });

    installFakeFetch([() => json({ error: { message: "The request cannot be completed because you have exceeded your quota." } }, 403)]);
    await expect(youtubeAdapter.publish({ account, content: "t", media: [video(10)], asVideo: true })).rejects.toMatchObject({
      kind: "api",
      retryable: false,
      message: expect.stringContaining("quota"),
    });
  });
});

describe("YouTube adapter: metrics", () => {
  it("reads statistics (strings) for up to 50 videos per call, views as impressions", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `v${i}`);
    const { requests } = installFakeFetch([
      (r) => {
        if (!r.url.startsWith("https://www.googleapis.com/youtube/v3/videos?part=statistics")) return undefined;
        const asked = new URL(r.url).searchParams.get("id")!.split(",");
        return json({ items: asked.map((id) => ({ id, statistics: { viewCount: "1200", likeCount: "30", commentCount: "4" } })) });
      },
    ]);
    const out = await youtubeAdapter.fetchMetrics!(account, ids);
    expect(requests).toHaveLength(2);
    expect(new URL(requests[0].url).searchParams.get("id")!.split(",")).toHaveLength(50);
    expect(out.get("v0")).toEqual({ likes: 30, comments: 4, impressions: 1200 });
  });
  it("treats hidden counts (omitted by YouTube) as unknown, not zero", async () => {
    installFakeFetch([() => json({ items: [{ id: "v1", statistics: { viewCount: "10" } }] })]);
    expect((await youtubeAdapter.fetchMetrics!(account, ["v1"])).get("v1")).toEqual({ likes: null, comments: null, impressions: 10 });
  });
});

describe("YouTube adapter: comments", () => {
  const since = new Date("2026-10-01T00:00:00Z");
  const thread = (id: string, over: { author?: string; publishedAt?: string; video?: string; replies?: string[] } = {}) => ({
    id: `T-${id}`,
    snippet: {
      videoId: over.video ?? "vid1",
      canReply: true,
      topLevelComment: {
        id,
        snippet: {
          authorDisplayName: "@viewer",
          authorProfileImageUrl: "https://yt3.ggpht.com/a.jpg",
          authorChannelUrl: "http://www.youtube.com/@viewer",
          authorChannelId: { value: over.author ?? "UCviewer" },
          textOriginal: `comment ${id}`,
          likeCount: 1,
          publishedAt: over.publishedAt ?? "2026-10-20T10:00:00Z",
        },
      },
    },
    replies: { comments: (over.replies ?? []).map((a) => ({ id: `${id}.r`, snippet: { authorChannelId: { value: a } } })) },
  });

  it("reads the whole channel's recent threads in one call, adds video titles, skips own and old comments", async () => {
    const { requests } = installFakeFetch([
      (r) => {
        const u = new URL(r.url);
        if (u.pathname === "/youtube/v3/commentThreads") {
          return json({
            items: [
              thread("c1"),
              thread("c2", { replies: ["UC123"] }),
              thread("c3", { author: "UC123" }),
              thread("c4", { publishedAt: "2026-09-01T00:00:00Z" }),
              thread("c5", { video: "vid2" }),
            ],
          });
        }
        if (u.pathname === "/youtube/v3/videos") return json({ items: [{ id: "vid1", snippet: { title: "Launch video", thumbnails: { medium: { url: "https://i.ytimg.com/m.jpg" } } } }] });
        return undefined;
      },
    ]);
    const out = await youtubeAdapter.fetchComments!(account, { knownPostIds: [], since });
    const q = new URL(requests[0].url).searchParams;
    expect(q.get("allThreadsRelatedToChannelId")).toBe("UC123");
    expect(q.get("part")).toBe("snippet,replies");
    expect(q.get("textFormat")).toBe("plainText");
    expect(new URL(requests[1].url).searchParams.get("id")).toBe("vid1,vid2");
    expect(out.map((c) => c.platformCommentId)).toEqual(["c1", "c2", "c5"]);
    expect(out[0]).toMatchObject({
      platformPostId: "vid1",
      postTitle: "Launch video",
      postThumbnailUrl: "https://i.ytimg.com/m.jpg",
      authorName: "viewer",
      authorHandle: "viewer",
      text: "comment c1",
      ownerReplied: false,
    });
    expect(out[1].ownerReplied).toBe(true);
    expect(out[2].postTitle).toBeNull();
  });

  it("replies with comments.insert (parentId = the top-level comment)", async () => {
    const { requests } = installFakeFetch([() => json({ id: "Ugx.reply" })]);
    await expect(youtubeAdapter.replyToComment!(account, { platformCommentId: "c1", platformPostId: "vid1" }, "Thanks!")).resolves.toEqual({ platformReplyId: "Ugx.reply" });
    expect(requests[0].url).toBe("https://www.googleapis.com/youtube/v3/comments?part=snippet");
    expect(requests[0].body).toEqual({ snippet: { parentId: "c1", textOriginal: "Thanks!" } });
  });

  it("explains a missing comment permission (connected before replies existed)", async () => {
    installFakeFetch([() => json({ error: { message: "Request had insufficient authentication scopes." } }, 403)]);
    await expect(youtubeAdapter.replyToComment!(account, { platformCommentId: "c1", platformPostId: "v" }, "x")).rejects.toMatchObject({ message: expect.stringContaining("Reconnect YouTube") });
    expect(youtubeAdapter.capabilities!({ scopes: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly" }).comments).toBe(false);
    expect(youtubeAdapter.capabilities!({ scopes: YOUTUBE_SCOPES.join(" ") }).comments).toBe(true);
  });
});
