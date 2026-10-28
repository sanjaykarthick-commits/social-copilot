/**
 * End-to-end check of the scheduler against the REAL Inngest dev server and a REAL
 * Postgres. Only api.x.com is faked (we have no X credentials in CI / sandboxes).
 *
 *   DATABASE_URL=postgresql://sc:sc@localhost:5432/social_copilot npm run e2e:scheduler
 *
 * It exercises the actual post service + publish-post function, so it validates the
 * parts mocks cannot: sleepUntil, the cancelOn CEL expression, event idempotency,
 * retries/onFailure, and stale-run protection.
 *
 * WARNING: truncates the users table (and everything under it). Local databases only.
 */
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";

const dbUrl = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)) {
  console.error("Refusing to run: DATABASE_URL must point at a LOCAL database (this script truncates tables).");
  process.exit(2);
}

Object.assign(process.env, {
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  TWITTER_CLIENT_ID: "e2e-id",
  TWITTER_CLIENT_SECRET: "e2e-secret",
  INNGEST_DEV: "1",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
});

const APP_PORT = 3011;
const DEV_PORT = 8288;

// ---- fake api.x.com (everything else passes through to the real fetch) ---------------------
type Tweet = { text: string; token: string; at: number };
const tweets: Tweet[] = [];
const attempts = new Map<string, number>(); // text -> calls seen
let badTokenWorks = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith("https://api.x.com/2/tweets")) return realFetch(input, init);
  const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
  const { text } = JSON.parse(String(init?.body)) as { text: string };
  const n = (attempts.get(text) ?? 0) + 1;
  attempts.set(text, n);
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (text.startsWith("F-reject")) return reply(403, { title: "Forbidden", detail: "You are not permitted to create a Tweet." });
  if (text.startsWith("G-flaky") && n <= 2) return reply(503, { detail: "Service Unavailable" });
  if (token === "tok-bad" && !badTokenWorks) return reply(403, { title: "Forbidden", detail: "Account suspended." });
  tweets.push({ text, token, at: Date.now() });
  return reply(201, { data: { id: String(1000 + tweets.length), text } });
}) as typeof fetch;

// ---- app code (imported after env + fetch are set up) --------------------------------------
const { serve } = await import("inngest/node");
const { inngest } = await import("@/lib/inngest/client");
const { functions } = await import("@/lib/inngest/functions");
const { sendPublishNow } = await import("@/lib/inngest/events");
const { getDb } = await import("@/lib/db");
const { posts, postTargets, users } = await import("@/lib/db/schema");
const { createPost, deletePost, publishPostNow, replacePost, reschedulePost } = await import("@/lib/posts");
const { getPostDTO } = await import("@/lib/posts-query");
const { saveConnectedAccount } = await import("@/lib/accounts");
const { upsertUser } = await import("@/lib/users");
const { eq, sql } = await import("drizzle-orm");

// ---- helpers ---------------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
async function waitFor<T>(label: string, fn: () => Promise<T | undefined | false>, timeoutMs = 90_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`timed out waiting for: ${label}`);
}
const status = async (id: string) => (await getDb().select({ s: posts.status }).from(posts).where(eq(posts.id, id)))[0]?.s;
const tweetsFor = (text: string) => tweets.filter((t) => t.text === text);

const procs: { dev?: ChildProcess; server?: http.Server } = {};
function shutdown() {
  procs.dev?.kill("SIGTERM");
  procs.server?.close();
}
process.on("exit", shutdown);

// ---- boot: app server + Inngest dev server ---------------------------------------------------
const handler = serve({ client: inngest, functions });
procs.server = http.createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => procs.server!.listen(APP_PORT, "127.0.0.1", r));

const dev = (procs.dev = spawn("npx", ["--yes", "inngest-cli@latest", "dev", "-u", `http://127.0.0.1:${APP_PORT}/api/inngest`, "--no-discovery", "-p", String(DEV_PORT)], {
  stdio: ["ignore", "pipe", "pipe"],
}));
const devLog: string[] = [];
dev.stdout?.on("data", (d) => devLog.push(String(d)));
dev.stderr?.on("data", (d) => devLog.push(String(d)));

console.log("Booting Inngest dev server and syncing the app...");
await waitFor("publish-post registered with the dev server", async () => {
  try {
    const r = await realFetch(`http://127.0.0.1:${DEV_PORT}/dev`);
    const j = (await r.json()) as { functions?: { id?: string; slug?: string }[] };
    return j.functions?.some((f) => JSON.stringify(f).includes("publish-post")) ? true : undefined;
  } catch {
    return undefined;
  }
}, 120_000);
console.log("Synced.\n");

// ---- fixtures --------------------------------------------------------------------------------
await getDb().execute(sql`TRUNCATE TABLE users RESTART IDENTITY CASCADE`);
const user = await upsertUser("user_e2e", { email: "e2e@example.com", name: "E2E" });
await getDb().execute(sql`update subscriptions set plan='premium', status='active' where user_id = ${user.id}`);
const actor = { userId: user.id, plan: "premium" as const };
const account = async (name: string, token = `tok-${name}`) => {
  const a = await saveConnectedAccount(user.id, "twitter", {
    accessToken: token,
    refreshToken: "r",
    expiresAt: new Date(Date.now() + 3600_000),
    scopes: "tweet.write",
    platformAccountId: `pid-${name}`,
    username: name,
    displayName: name,
    profileImageUrl: null,
  });
  return a;
};
const good = await account("good");
const bad = await account("bad", "tok-bad");
// The service enforces a 1-minute lead time; passing `now` in the past lets us schedule seconds ahead for real.
const fakeNow = () => new Date(Date.now() - 5 * 60_000);
const soon = (s: number) => new Date(Date.now() + s * 1000).toISOString();
const T = (accountId: string) => ({ socialAccountId: accountId, postAsVideo: false });

// ---- scenarios (run concurrently; each asserts on its own post/text) -------------------------
async function scenarioPostNow() {
  const p = await createPost(actor, { content: "A-now", targets: [T(good.id)], mediaIds: [], mode: "now" });
  await waitFor("A published", async () => (await status(p.id)) === "published");
  check("post-now publishes through Inngest exactly once", tweetsFor("A-now").length === 1);
  const dto = (await getPostDTO(user.id, p.id))!;
  check("post-now stores the platform URL on the target", dto.targets[0].platformPostUrl?.includes("/status/") === true, dto.targets[0].platformPostUrl ?? "");
}

async function scenarioScheduled() {
  const at = Date.now() + 22_000;
  const p = await createPost(actor, { content: "B-sched", targets: [T(good.id)], mediaIds: [], mode: "schedule", scheduledAt: new Date(at).toISOString() }, fakeNow());
  await sleep(10_000);
  check("scheduled post does NOT publish early", (await status(p.id)) === "scheduled" && tweetsFor("B-sched").length === 0);
  await waitFor("B published", async () => (await status(p.id)) === "published");
  const t = tweetsFor("B-sched")[0];
  check("scheduled post publishes at its time (not early, < 20s late)", t.at >= at - 500 && t.at - at < 20_000, `${((t.at - at) / 1000).toFixed(1)}s after target`);
  check("scheduled post published exactly once", tweetsFor("B-sched").length === 1);
}

async function scenarioReschedule() {
  const p = await createPost(actor, { content: "C-move", targets: [T(good.id)], mediaIds: [], mode: "schedule", scheduledAt: soon(18) }, fakeNow());
  const newAt = Date.now() + 40_000;
  await reschedulePost(actor, p.id, new Date(newAt), fakeNow());
  await sleep(26_000); // well past the ORIGINAL time
  check("rescheduled post does NOT publish at the old time (old run cancelled)", tweetsFor("C-move").length === 0 && (await status(p.id)) === "scheduled");
  await waitFor("C published", async () => (await status(p.id)) === "published");
  const t = tweetsFor("C-move")[0];
  check("rescheduled post publishes at the NEW time", t.at >= newAt - 500, `${((t.at - newAt) / 1000).toFixed(1)}s after new time`);
  await sleep(4000);
  check("rescheduled post published exactly once (no double publish)", tweetsFor("C-move").length === 1);
}

async function scenarioDelete() {
  const p = await createPost(actor, { content: "D-delete", targets: [T(good.id)], mediaIds: [], mode: "schedule", scheduledAt: soon(15) }, fakeNow());
  await deletePost(actor, p.id);
  await sleep(24_000);
  check("deleted scheduled post never publishes", tweetsFor("D-delete").length === 0 && (await status(p.id)) === undefined);
}

async function scenarioToDraft() {
  const p = await createPost(actor, { content: "E-draft", targets: [T(good.id)], mediaIds: [], mode: "schedule", scheduledAt: soon(15) }, fakeNow());
  await replacePost(actor, p.id, { content: "E-draft", targets: [T(good.id)], mediaIds: [], mode: "draft" }, fakeNow());
  await sleep(24_000);
  check("scheduled post moved back to draft never publishes", tweetsFor("E-draft").length === 0 && (await status(p.id)) === "draft");
}

async function scenarioPermanentFailure() {
  const p = await createPost(actor, { content: "F-reject", targets: [T(good.id)], mediaIds: [], mode: "now" });
  await waitFor("F failed", async () => (await status(p.id)) === "failed");
  const dto = (await getPostDTO(user.id, p.id))!;
  check("a permanent platform error fails the post with the platform's reason", dto.failureReason?.includes("not permitted") === true, dto.failureReason ?? "");
  await sleep(6000);
  check("a permanent error is NOT retried", attempts.get("F-reject") === 1, `${attempts.get("F-reject")} call(s)`);
}

async function scenarioTransientFailure() {
  const p = await createPost(actor, { content: "G-flaky", targets: [T(good.id)], mediaIds: [], mode: "now" });
  await waitFor("G published after retries", async () => (await status(p.id)) === "published", 120_000);
  check("a transient 5xx is retried by Inngest until it succeeds", attempts.get("G-flaky") === 3, `${attempts.get("G-flaky")} call(s)`);
  check("…and posted exactly once", tweetsFor("G-flaky").length === 1);
}

async function scenarioDuplicateDelivery() {
  const p = await createPost(actor, { content: "H-dup", targets: [T(good.id)], mediaIds: [], mode: "now" });
  const [row] = await getDb().select().from(posts).where(eq(posts.id, p.id));
  await sendPublishNow({ postId: p.id, token: row.inngestEventId! }).catch(() => undefined); // same event id again
  await waitFor("H published", async () => (await status(p.id)) === "published");
  await sleep(5000);
  check("the same publish event delivered twice posts once", tweetsFor("H-dup").length === 1);
}

async function scenarioLostCancel() {
  const p = await createPost(actor, { content: "I-stale", targets: [T(good.id)], mediaIds: [], mode: "schedule", scheduledAt: soon(15) }, fakeNow());
  // Simulate a reschedule whose cancel event was lost: the DB moves on, the old run still wakes up.
  await getDb().update(posts).set({ inngestEventId: "someone-else", scheduledAt: new Date(Date.now() + 3600_000) }).where(eq(posts.id, p.id));
  await sleep(24_000);
  check("a stale run (lost cancel) does nothing because the DB token no longer matches", tweetsFor("I-stale").length === 0 && (await status(p.id)) === "scheduled");
}

async function scenarioPartialFailureAndRetry() {
  const p = await createPost(actor, { content: "J-multi", targets: [T(good.id), T(bad.id)], mediaIds: [], mode: "now" });
  await waitFor("J failed (partial)", async () => (await status(p.id)) === "failed");
  let dto = (await getPostDTO(user.id, p.id))!;
  const byUser = Object.fromEntries(dto.targets.map((t) => [t.account?.username, t.status]));
  check("one platform failing does not block the other", byUser.good === "published" && byUser.bad === "failed", JSON.stringify(byUser));
  check("the post is marked failed with a per-platform reason", dto.failureReason?.includes("suspended") === true, dto.failureReason ?? "");

  badTokenWorks = true; // the user fixed the problem
  await publishPostNow(actor, p.id);
  await waitFor("J published after retry", async () => (await status(p.id)) === "published");
  dto = (await getPostDTO(user.id, p.id))!;
  check("retry publishes the failed platform", dto.targets.every((t) => t.status === "published"));
  check("retry does NOT re-post to the platform that already succeeded", tweetsFor("J-multi").filter((t) => t.token === "tok-good").length === 1);
}

try {
  console.log("Running scenarios (about a minute)...\n");
  const scenarios = [
    scenarioPostNow,
    scenarioScheduled,
    scenarioReschedule,
    scenarioDelete,
    scenarioToDraft,
    scenarioPermanentFailure,
    scenarioTransientFailure,
    scenarioDuplicateDelivery,
    scenarioLostCancel,
    scenarioPartialFailureAndRetry,
  ];
  const settled = await Promise.allSettled(scenarios.map((s) => s()));
  settled.forEach((r, i) => {
    if (r.status === "rejected") check(scenarios[i].name, false, r.reason instanceof Error ? r.reason.message : String(r.reason));
  });
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\nLast Inngest dev server output:\n" + devLog.join("").split("\n").slice(-40).join("\n"));
  }
  shutdown();
  await getDb().execute(sql`TRUNCATE TABLE users RESTART IDENTITY CASCADE`).catch(() => undefined);
  void postTargets; void users;
  process.exit(failed.length ? 1 : 0);
}
