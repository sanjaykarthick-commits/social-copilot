/**
 * Seeds a LOCAL database with a realistic demo account for screenshots and manual testing.
 *   DATABASE_URL=postgresql://sc:sc@localhost:5432/social_copilot TOKEN_ENCRYPTION_KEY=... npm run seed:demo
 * WARNING: truncates the users table (and everything under it).
 */
import { sql } from "drizzle-orm";

const dbUrl = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)) {
  console.error("Refusing to run: DATABASE_URL must point at a LOCAL database.");
  process.exit(2);
}
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString("base64");

const { getDb } = await import("@/lib/db");
const { commentReplies, comments, mediaAssets, postMetrics, postTargets, posts, subscriptions, users } = await import("@/lib/db/schema");
const { saveConnectedAccount } = await import("@/lib/accounts");
const { upsertUser } = await import("@/lib/users");
const { toInstant, fromInstant } = await import("@/lib/time");
const { eq } = await import("drizzle-orm");

const BASE = process.env.DEMO_ASSET_BASE ?? "http://localhost:3000/demo";
const TZ = "Asia/Kolkata";
const db = getDb();
await db.execute(sql`TRUNCATE TABLE users RESTART IDENTITY CASCADE`);

const user = await upsertUser(process.env.E2E_FAKE_USER_ID ?? "user_e2e", { email: "sanjay@example.com", name: "Sanjay Karthick" });
await db.update(users).set({ timezone: TZ }).where(eq(users.id, user.id));
await db.update(subscriptions).set({ plan: "premium", status: "active" }).where(eq(subscriptions.userId, user.id)); // so the demo is not capped at 10 posts

const tokens = { accessToken: "demo-access", refreshToken: "demo-refresh", expiresAt: new Date(Date.now() + 90 * 86_400_000), scopes: "demo" };
const ig = await saveConnectedAccount(user.id, "instagram", {
  ...tokens,
  refreshToken: null,
  expiresAt: new Date(Date.now() + 50 * 86_400_000),
  scopes: "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_insights",
  platformAccountId: "17841400000001",
  username: "karthick.builds",
  displayName: "Karthick Builds",
  profileImageUrl: `${BASE}/avatar-x.jpg`,
});
const yt = await saveConnectedAccount(user.id, "youtube", {
  ...tokens,
  scopes: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl",
  platformAccountId: "UCdemo",
  username: "karthickbuilds",
  displayName: "Karthick Builds",
  profileImageUrl: `${BASE}/avatar-yt.jpg`,
});
// LinkedIn as most apps get it: publishing only (stats and comments need LinkedIn's approval), 60-day token, no refresh.
const li = await saveConnectedAccount(user.id, "linkedin", {
  ...tokens,
  refreshToken: null,
  expiresAt: new Date(Date.now() + 5 * 86_400_000),
  scopes: "openid,profile,w_member_social",
  platformAccountId: "abcDEF123",
  username: null,
  displayName: "Sanjay Karthick",
  profileImageUrl: `${BASE}/avatar-x.jpg`,
});
const ACCOUNTS = { ig, yt, li } as const;
type Key = keyof typeof ACCOUNTS;
const POST_URL: Record<Key, (id: string) => string> = {
  ig: (id) => `https://www.instagram.com/p/${id}/`,
  yt: (id) => `https://www.youtube.com/watch?v=${id}`,
  li: (id) => `https://www.linkedin.com/feed/update/urn:li:share:${id}/`,
};

/** day offset from today + wall-clock time in the demo timezone */
function at(dayOffset: number, hour: number, minute = 0) {
  const t = fromInstant(new Date(Date.now() + dayOffset * 86_400_000), TZ);
  return toInstant({ year: t.year, month: t.month, day: t.day, hour, minute }, TZ);
}

type Seed = {
  content: string;
  status: "draft" | "scheduled" | "published" | "failed";
  when: Date | null;
  targets: Key[];
  images?: number;
  video?: boolean;
  metrics?: Partial<Record<Key, { likes: number | null; comments: number | null; impressions: number | null }>>;
  error?: string;
};

const seeds: Seed[] = [
  {
    content: "We just shipped scheduling for Instagram, YouTube and LinkedIn. Write once, pick your accounts, and we handle the rest. #buildinpublic",
    status: "published",
    when: at(-1, 10, 30),
    targets: ["ig", "li"],
    images: 2,
    metrics: { ig: { likes: 412, comments: 38, impressions: 9400 }, li: { likes: null, comments: null, impressions: null } },
  },
  {
    content: "Behind the scenes: how we plan a week of content in 20 minutes\nA walkthrough of the calendar view.",
    status: "published",
    when: at(-2, 18, 0),
    targets: ["yt", "ig"],
    video: true,
    metrics: { yt: { likes: 96, comments: 14, impressions: 5200 }, ig: { likes: 230, comments: 19, impressions: 7800 } },
  },
  { content: "3 things we learned from scheduling 10,000 posts", status: "published", when: at(-4, 9, 15), targets: ["li"] },
  {
    content: "Monthly update: calendar drag-and-drop, timezone-aware scheduling, and a faster composer.\nWatch the full release notes.",
    status: "published",
    when: at(-9, 17, 0),
    targets: ["yt"],
    video: true,
    metrics: { yt: { likes: 240, comments: 31, impressions: 12800 } },
  },
  { content: "Desk setup tour ☕️ What does yours look like?", status: "published", when: at(-15, 8, 45), targets: ["ig"], images: 3, metrics: { ig: { likes: 518, comments: 64, impressions: null } } },
  { content: "Our favourite keyboard shortcuts for writing faster", status: "published", when: at(-22, 12, 0), targets: ["ig"], images: 1, metrics: { ig: { likes: 127, comments: 9, impressions: 2900 } } },
  {
    content: "Announcing our new analytics dashboard 📊 See what worked, at a glance.",
    status: "failed",
    when: at(-3, 11, 0),
    targets: ["ig"],
    images: 1,
    error: "Instagram could not process the media: The aspect ratio is not supported. Check the format (JPEG photos; MP4/MOV video for reels).",
  },
  { content: "Good morning! What are you shipping this week?", status: "scheduled", when: at(1, 9, 30), targets: ["li"] },
  { content: "Weekly roundup: the five best posts from our community\nPlus a look at what's coming next.", status: "scheduled", when: at(1, 18, 0), targets: ["yt", "ig"], video: true },
  { content: "Case study: how a two-person team doubled their reach with a posting schedule", status: "scheduled", when: at(2, 11, 0), targets: ["li", "ig"], images: 1 },
  { content: "Q&A tomorrow. Drop your questions below 👇", status: "scheduled", when: at(4, 14, 0), targets: ["ig"], images: 1 },
  { content: "Product tour: scheduling across platforms in under 3 minutes", status: "scheduled", when: at(6, 10, 0), targets: ["yt"], video: true },
  { content: "Hiring: we're looking for a designer who loves calm software.", status: "scheduled", when: at(9, 9, 0), targets: ["li"] },
  { content: "Idea: a carousel on the mistakes we made in our first 100 days", status: "draft", when: null, targets: ["ig"] },
  { content: "Launch video script (rough)", status: "draft", when: at(12, 16, 0), targets: ["yt"], video: true },
];

let imgN = 0;
const publishedTargets: { key: Key; targetId: string; platformPostId: string; url: string; content: string; when: Date }[] = [];
for (const s of seeds) {
  const [post] = await db
    .insert(posts)
    .values({
      userId: user.id,
      content: s.content,
      status: s.status,
      scheduledAt: s.status === "published" ? null : s.when,
      publishedAt: s.status === "published" ? s.when : null,
      queuedAt: s.status === "draft" ? null : (s.when ?? new Date()),
      failureReason: s.status === "failed" ? `Instagram: ${s.error}` : null,
      inngestEventId: s.status === "scheduled" ? `seed-${Math.random().toString(36).slice(2)}` : null,
      createdAt: s.when ?? new Date(),
    })
    .returning();

  for (const t of s.targets) {
    const acct = ACCOUNTS[t];
    const pid = `demo${post.id.slice(0, 8)}${t}`;
    const [target] = await db
      .insert(postTargets)
      .values({
        postId: post.id,
        socialAccountId: acct.id,
        platform: acct.platform,
        status: s.status === "published" ? "published" : s.status === "failed" ? "failed" : "pending",
        postAsVideo: t === "yt",
        error: s.status === "failed" ? s.error : null,
        platformPostId: s.status === "published" ? pid : null,
        platformPostUrl: s.status === "published" ? POST_URL[t](pid) : null,
        publishedAt: s.status === "published" ? s.when : null,
      })
      .returning();
    const m = s.metrics?.[t];
    if (m && s.status === "published" && (m.likes !== null || m.comments !== null || m.impressions !== null)) await db.insert(postMetrics).values({ postTargetId: target.id, ...m });
    if (s.status === "published") publishedTargets.push({ key: t, targetId: target.id, platformPostId: pid, url: POST_URL[t](pid), content: s.content, when: s.when! });
  }

  for (let i = 0; i < (s.images ?? 0); i += 1) {
    imgN += 1;
    await db.insert(mediaAssets).values({ userId: user.id, postId: post.id, url: `${BASE}/photo${(imgN % 3) + 1}.jpg`, type: "image", width: 1200, height: 800, sizeBytes: 90_000, position: i });
  }
  if (s.video) await db.insert(mediaAssets).values({ userId: user.id, postId: post.id, url: `${BASE}/clip.mp4`, type: "video", sizeBytes: 60_000, position: 0 });
}

// Comments for the inbox (demo only). LinkedIn has none: without LinkedIn's approval they cannot be read.
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const demoComments: { key: Key; post: number; author: string; handle: string | null; text: string; at: Date; likes: number; status?: "replied" | "archived"; reply?: string }[] = [
  { key: "ig", post: 0, author: "Priya Raman", handle: "priya.designs", text: "This is exactly what I needed. Does it work with Reels too?", at: hoursAgo(2), likes: 4 },
  { key: "ig", post: 0, author: "Arjun", handle: "arjun.codes", text: "Congrats on the launch! 🚀", at: hoursAgo(5), likes: 2 },
  { key: "yt", post: 1, author: "Meera Iyer", handle: "MeeraMakes", text: "Great walkthrough. What do you use to edit the thumbnails?", at: hoursAgo(9), likes: 7 },
  { key: "ig", post: 1, author: "Rahul", handle: "rahul.shoots", text: "Can I schedule the same reel to YouTube Shorts?", at: hoursAgo(20), likes: 1 },
  { key: "yt", post: 3, author: "Dev Patel", handle: "devbuilds", text: "The drag and drop calendar is so smooth. Is there a mobile app?", at: hoursAgo(40), likes: 12, status: "replied", reply: "Thanks Dev! The web app works on phones today; a native app is on our list." },
  { key: "ig", post: 4, author: "Ana", handle: "ana.workspace", text: "Where is that lamp from?", at: hoursAgo(70), likes: 3, status: "archived" },
];
for (const [i, c] of demoComments.entries()) {
  const target = publishedTargets.filter((t) => t.key === c.key)[Math.min(c.post, publishedTargets.filter((t) => t.key === c.key).length - 1)];
  const acct = ACCOUNTS[c.key];
  const [row] = await db
    .insert(comments)
    .values({
      userId: user.id,
      socialAccountId: acct.id,
      platform: acct.platform,
      platformCommentId: `demo-comment-${i}`,
      platformPostId: target.platformPostId,
      postTargetId: target.targetId,
      postUrl: target.url,
      postTitle: target.content.split("\n")[0].slice(0, 140),
      postThumbnailUrl: c.key === "ig" ? `${BASE}/photo1.jpg` : null,
      authorName: c.author,
      authorHandle: c.handle,
      text: c.text,
      likeCount: c.likes,
      commentedAt: c.at,
      status: c.status ?? "open",
      repliedAt: c.status === "replied" ? new Date(c.at.getTime() + 3_600_000) : null,
    })
    .returning();
  if (c.reply) {
    await db.insert(commentReplies).values({ commentId: row.id, userId: user.id, text: c.reply, status: "sent", platformReplyId: `demo-reply-${i}`, idempotencyKey: `demo-${i}`, createdAt: new Date(c.at.getTime() + 3_600_000) });
  }
}

console.log(`Seeded ${seeds.length} posts, 3 accounts and ${demoComments.length} comments for ${user.clerkId} (${TZ}).`);
process.exit(0);
