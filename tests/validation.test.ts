import { describe, expect, it } from "vitest";
import { MAX_LEAD_MS, parseCollaborators, postBodySchema, validateForPublish, type ValidationTarget } from "@/lib/validation/posts";

const NOW = new Date("2026-10-27T12:00:00Z");
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);
const x = (over: Partial<ValidationTarget> = {}): ValidationTarget => ({ socialAccountId: "a1", platform: "twitter", label: "@asha on X (Twitter)", ...over });
const yt = (over: Partial<ValidationTarget> = {}): ValidationTarget => ({ socialAccountId: "a2", platform: "youtube", label: "My channel on YouTube", postAsVideo: true, ...over });

const run = (o: Partial<Parameters<typeof validateForPublish>[0]> = {}) =>
  validateForPublish({ content: "hi", targets: [x()], media: [], mode: "schedule", scheduledAt: later(60), now: NOW, ...o });
const messages = (o?: Parameters<typeof run>[0]) => run(o).map((i) => i.message);

describe("validateForPublish", () => {
  it("accepts a normal scheduled X post", () => {
    expect(run()).toEqual([]);
  });

  describe("schedule", () => {
    it("requires a time in schedule mode, but not in post-now mode", () => {
      expect(messages({ scheduledAt: null })).toContain("Choose a date and time.");
      expect(run({ mode: "now", scheduledAt: null })).toEqual([]);
    });
    it("needs at least a minute of lead time and at most a year", () => {
      expect(messages({ scheduledAt: new Date(NOW.getTime() + 30_000) })[0]).toMatch(/at least a minute/);
      expect(messages({ scheduledAt: later(-5) })[0]).toMatch(/at least a minute/);
      expect(run({ scheduledAt: later(2) })).toEqual([]);
      expect(messages({ scheduledAt: new Date(NOW.getTime() + MAX_LEAD_MS + 1000) })[0]).toMatch(/up to a year/);
    });
  });

  describe("targets", () => {
    it("requires at least one", () => {
      expect(messages({ targets: [] })).toContain("Pick at least one account to post to.");
    });
    it("flags an unbuilt platform instead of pretending it works", () => {
      const out = messages({ targets: [x({ platform: "tiktok", label: "TikTok" })] });
      expect(out[0]).toContain("not available yet");
    });
  });

  describe("X", () => {
    it("enforces 280 weighted characters", () => {
      expect(run({ content: "a".repeat(280) })).toEqual([]);
      expect(messages({ content: "a".repeat(281) })[0]).toMatch(/over the 280 character limit by 1\./);
      expect(run({ content: `${"a".repeat(250)} https://example.com/${"z".repeat(100)}` })).toEqual([]);
      expect(messages({ content: "🙂".repeat(141) })[0]).toMatch(/over/);
    });
    it("validates a per-account override instead of the shared text", () => {
      expect(run({ content: "short", targets: [x({ contentOverride: "b".repeat(300) })] }).length).toBe(1);
      expect(run({ content: "b".repeat(300), targets: [x({ contentOverride: "short" })] })).toEqual([]);
    });
    it("allows media without text, but not an empty post", () => {
      expect(run({ content: "", media: [{ type: "image" }] })).toEqual([]);
      expect(messages({ content: "   " })[0]).toMatch(/add some text or media/);
    });
    it("allows 4 images or 1 video, nothing else", () => {
      const img = { type: "image" as const };
      expect(run({ media: [img, img, img, img] })).toEqual([]);
      expect(messages({ media: [img, img, img, img, img] })[0]).toMatch(/at most 4/);
      expect(run({ media: [{ type: "video" }] })).toEqual([]);
      expect(messages({ media: [{ type: "video" }, { type: "video" }] })[0]).toMatch(/one video/);
      expect(messages({ media: [img, { type: "video" }] })[0]).toMatch(/images or a video, not both/);
    });
  });

  describe("X image size", () => {
    const MB = 1024 * 1024;
    it("rejects still images over 5 MB, allows GIFs and smaller images", () => {
      expect(messages({ media: [{ type: "image", sizeBytes: 6 * MB }] })[0]).toMatch(/5 MB or smaller/);
      expect(run({ media: [{ type: "image", sizeBytes: 5 * MB }] })).toEqual([]);
      expect(run({ media: [{ type: "image", sizeBytes: 12 * MB, isGif: true }] })).toEqual([]);
      expect(run({ media: [{ type: "image" }] })).toEqual([]); // size unknown: let the adapter decide
    });
  });

  describe("YouTube", () => {
    it("needs exactly one video, 'post as video' on, and a title", () => {
      expect(run({ targets: [yt()], media: [{ type: "video" }], content: "My title\nDescription" })).toEqual([]);
      expect(messages({ targets: [yt()], media: [] }).join(" ")).toMatch(/exactly one video/);
      expect(messages({ targets: [yt({ postAsVideo: false })], media: [{ type: "video" }] }).join(" ")).toMatch(/Post as video/);
      expect(messages({ targets: [yt()], media: [{ type: "video" }], content: " " }).join(" ")).toMatch(/title/);
      expect(messages({ targets: [yt()], media: [{ type: "image" }, { type: "image" }] }).join(" ")).toMatch(/exactly one video/);
    });
    it("allows X + YouTube in one post when a video is attached", () => {
      expect(run({ targets: [x(), yt()], media: [{ type: "video" }], content: "Launch day" })).toEqual([]);
    });
    it("reports problems per account so the UI can point at the right card", () => {
      const issues = run({ targets: [x(), yt()], media: [{ type: "image" }], content: "Launch day" });
      expect(issues.every((i) => i.field === "target")).toBe(true);
      expect(new Set(issues.map((i) => i.socialAccountId))).toEqual(new Set(["a2"]));
    });
  });
});

describe("postBodySchema", () => {
  const id = "3f2c0b7e-8c34-4e0c-9f0e-3b1d2a4c5d6e";
  it("applies defaults for a bare draft", () => {
    const r = postBodySchema.parse({ mode: "draft" });
    expect(r).toMatchObject({ content: "", targets: [], mediaIds: [], mode: "draft" });
  });
  it("accepts ISO times with an offset and rejects loose strings", () => {
    expect(postBodySchema.safeParse({ mode: "schedule", scheduledAt: "2026-11-01T10:00:00+05:30", targets: [{ socialAccountId: id }] }).success).toBe(true);
    expect(postBodySchema.safeParse({ mode: "schedule", scheduledAt: "tomorrow 5pm" }).success).toBe(false);
    expect(postBodySchema.safeParse({ mode: "schedule", scheduledAt: "2026-11-01 10:00" }).success).toBe(false);
  });
  it("rejects bad modes, non-uuid ids and oversize content", () => {
    expect(postBodySchema.safeParse({ mode: "publish" }).success).toBe(false);
    expect(postBodySchema.safeParse({ mode: "draft", targets: [{ socialAccountId: "123" }] }).success).toBe(false);
    expect(postBodySchema.safeParse({ mode: "draft", content: "x".repeat(5001) }).success).toBe(false);
  });

  describe("Instagram", () => {
    const ig = (over: Partial<ValidationTarget> = {}): ValidationTarget => ({ socialAccountId: "a3", platform: "instagram", label: "@asha on Instagram", ...over });
    const photo = (w = 1080, h = 1350) => ({ type: "image" as const, width: w, height: h });
    it("needs a photo or video (no text-only posts)", () => {
      expect(messages({ targets: [ig()] })[0]).toMatch(/at least one photo or video/);
      expect(run({ targets: [ig()], media: [photo()] })).toEqual([]);
      expect(run({ targets: [ig()], content: "", media: [{ type: "video", sizeBytes: 10 }] })).toEqual([]);
    });
    it("enforces 2,200 characters and 30 hashtags", () => {
      expect(run({ targets: [ig()], media: [photo()], content: "a".repeat(2200) })).toEqual([]);
      expect(messages({ targets: [ig()], media: [photo()], content: "a".repeat(2201) })[0]).toMatch(/2,200 character limit/);
      const tags = (n: number) => Array.from({ length: n }, (_, i) => `#t${i}`).join(" ");
      expect(run({ targets: [ig()], media: [photo()], content: tags(30) })).toEqual([]);
      expect(messages({ targets: [ig()], media: [photo()], content: tags(31) })[0]).toMatch(/30 hashtags/);
    });
    it("checks the photo shape (4:5 to 1.91:1) when dimensions are known", () => {
      expect(run({ targets: [ig()], media: [photo(1080, 1350)] })).toEqual([]); // 4:5
      expect(run({ targets: [ig()], media: [photo(1910, 1000)] })).toEqual([]); // 1.91:1
      expect(messages({ targets: [ig()], media: [photo(1080, 1920)] })[0]).toMatch(/between 4:5/); // 9:16 story shape
      expect(messages({ targets: [ig()], media: [photo(3000, 1000)] })[0]).toMatch(/between 4:5/);
      expect(run({ targets: [ig()], media: [{ type: "image" }] })).toEqual([]); // unknown size: let Instagram decide
    });
    it("limits reels to 300 MB", () => {
      expect(messages({ targets: [ig()], media: [{ type: "video", sizeBytes: 301 * 1024 * 1024 }] })[0]).toMatch(/300 MB/);
    });
    it("allows up to 3 valid collaborator usernames", () => {
      expect(run({ targets: [ig({ collaborators: ["ben_k", "cara.co", "dev"] })], media: [photo()] })).toEqual([]);
      expect(messages({ targets: [ig({ collaborators: ["a", "b", "c", "d"] })], media: [photo()] })[0]).toMatch(/at most 3 collaborators/);
      expect(messages({ targets: [ig({ collaborators: ["not a name!"] })], media: [photo()] })[0]).toMatch(/"not a name!" is not a valid Instagram username/);
      expect(messages({ targets: [ig({ collaborators: ["x".repeat(31)] })], media: [photo()] })[0]).toMatch(/not a valid Instagram username/);
    });
    it("collaborators are Instagram only", () => {
      expect(messages({ targets: [x({ collaborators: ["ben_k"] })] })[0]).toMatch(/collaborators are only available on Instagram/);
    });
  });

  describe("collaborators input", () => {
    it("parses the composer field: strips @, splits on commas or spaces, lowercases, drops duplicates", () => {
      expect(parseCollaborators(" @Ben_K, cara.co  @@dev ,, ben_k ")).toEqual(["ben_k", "cara.co", "dev"]);
      expect(parseCollaborators("")).toEqual([]);
    });
    it("the API normalizes and enforces the same rules", () => {
      const t = (collaborators: string[]) => postBodySchema.safeParse({ mode: "draft", targets: [{ socialAccountId: id, collaborators }] });
      const ok = t(["@Ben_K", " cara.co ", "ben_k"]);
      expect(ok.success && ok.data.targets[0].collaborators).toEqual(["ben_k", "cara.co"]);
      expect(t(["a", "b", "c", "d"]).success).toBe(false);
      expect(t(["bad name"]).success).toBe(false);
      expect(t(["@"]).success).toBe(false);
      const none = postBodySchema.parse({ mode: "draft", targets: [{ socialAccountId: id }] });
      expect(none.targets[0].collaborators).toBeUndefined();
    });
  });

  describe("LinkedIn", () => {
    const li: ValidationTarget = { socialAccountId: "a4", platform: "linkedin", label: "Asha on LinkedIn" };
    it("allows text only, photos, or one video", () => {
      expect(run({ targets: [li], content: "Hello" })).toEqual([]);
      expect(run({ targets: [li], media: [{ type: "image" }, { type: "image" }] })).toEqual([]);
      expect(run({ targets: [li], media: [{ type: "video", sizeBytes: 10 }] })).toEqual([]);
      expect(messages({ targets: [li], media: [{ type: "image" }, { type: "video" }] })[0]).toMatch(/not both/);
      expect(messages({ targets: [li], media: [{ type: "video" }, { type: "video" }] })[0]).toMatch(/one video/);
      expect(messages({ targets: [li], media: [{ type: "video", sizeBytes: 600 * 1024 * 1024 }] })[0]).toMatch(/500 MB/);
      expect(messages({ targets: [li], content: "a".repeat(3001) })[0]).toMatch(/3,000 character limit/);
    });
  });
});
