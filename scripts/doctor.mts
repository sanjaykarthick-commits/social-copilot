/**
 * Go-live check: `npm run doctor`. Reads .env.local / .env, checks every integration, and prints the exact
 * URLs to register in each provider's console. Exits 1 if something required is missing.
 * Prints variable NAMES only, never their values.
 */
import { config } from "dotenv";
import pg from "pg";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

const env = (k: string) => {
  const v = process.env[k];
  return v && v.trim() ? v.trim() : undefined;
};
type Status = "ok" | "warn" | "fail" | "off";
const rows: { status: Status; area: string; detail: string }[] = [];
const add = (status: Status, area: string, detail: string) => rows.push({ status, area, detail });
const missing = (...keys: string[]) => keys.filter((k) => !env(k));

// --- App URL ------------------------------------------------------------------------------------
const appUrlRaw = env("NEXT_PUBLIC_APP_URL") ?? "http://localhost:3000";
let appUrl = appUrlRaw.replace(/\/$/, "");
let isLocal = true;
try {
  const u = new URL(appUrl);
  isLocal = ["localhost", "127.0.0.1"].includes(u.hostname);
  if (u.protocol !== "https:" && !isLocal) add("fail", "App URL", "NEXT_PUBLIC_APP_URL must use https.");
  else if (isLocal) add("warn", "App URL", `${appUrl} is local. Instagram and LinkedIn only redirect to an https URL you control: use your Vercel domain or an ngrok tunnel.`);
  else add("ok", "App URL", appUrl);
} catch {
  add("fail", "App URL", "NEXT_PUBLIC_APP_URL is not a valid URL.");
  appUrl = "https://YOUR-DOMAIN";
}

// --- Clerk --------------------------------------------------------------------------------------
{
  const m = missing("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY");
  if (m.length) add("fail", "Sign-in (Clerk)", `missing ${m.join(", ")}`);
  else {
    const live = env("CLERK_SECRET_KEY")!.startsWith("sk_live_");
    add(isLocal || live ? "ok" : "warn", "Sign-in (Clerk)", live ? "production keys" : "development keys (switch to production keys for your live domain)");
  }
  add(env("CLERK_WEBHOOK_SECRET") ? "ok" : "warn", "Clerk webhook", env("CLERK_WEBHOOK_SECRET") ? "signing secret set" : "CLERK_WEBHOOK_SECRET missing: profile changes and account deletions in Clerk will not sync");
}

// --- Encryption key -----------------------------------------------------------------------------
{
  const k = env("TOKEN_ENCRYPTION_KEY");
  const bytes = !k ? 0 : /^[0-9a-f]{64}$/i.test(k) ? 32 : Buffer.from(k, "base64").length;
  if (!k) add("fail", "Token encryption", "TOKEN_ENCRYPTION_KEY missing (openssl rand -base64 32)");
  else if (bytes !== 32) add("fail", "Token encryption", `TOKEN_ENCRYPTION_KEY must be 32 bytes (got ${bytes})`);
  else add("ok", "Token encryption", "32-byte key");
}

// --- Database -----------------------------------------------------------------------------------
if (!env("DATABASE_URL")) add("fail", "Database", "DATABASE_URL missing");
else {
  const client = new pg.Client({ connectionString: env("DATABASE_URL"), connectionTimeoutMillis: 8000 });
  try {
    await client.connect();
    const { rows: cols } = await client.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name in ('users','social_accounts','posts','post_targets','comments','comment_replies')`,
    );
    const has = (t: string, c?: string) => cols.some((r) => r.table_name === t && (!c || r.column_name === c));
    const needed = ["users", "social_accounts", "posts", "post_targets", "comments", "comment_replies"].filter((t) => !has(t));
    if (needed.length || !has("post_targets", "publish_state")) add("fail", "Database", `connected, but the schema is out of date (${needed.join(", ") || "post_targets.publish_state"}). Run: npm run db:push`);
    else add("ok", "Database", "connected, schema up to date");
  } catch (e) {
    add("fail", "Database", `cannot connect: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await client.end().catch(() => {});
  }
}

// --- Media --------------------------------------------------------------------------------------
{
  const m = missing("NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY", "IMAGEKIT_PRIVATE_KEY", "NEXT_PUBLIC_IMAGEKIT_URL_ENDPOINT");
  add(m.length ? "fail" : "ok", "Media (ImageKit)", m.length ? `missing ${m.join(", ")} (Instagram and YouTube posts need media)` : "configured");
}

// --- Scheduler ----------------------------------------------------------------------------------
if (isLocal) add(env("INNGEST_DEV") ? "ok" : "warn", "Scheduler (Inngest)", env("INNGEST_DEV") ? "local dev server mode: run `npm run inngest:dev`" : "set INNGEST_DEV=1 locally and run `npm run inngest:dev`");
else if (env("INNGEST_DEV")) add("fail", "Scheduler (Inngest)", "INNGEST_DEV is set on a live URL: remove it, or scheduled posts never run");
else {
  const m = missing("INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY");
  add(m.length ? "fail" : "ok", "Scheduler (Inngest)", m.length ? `missing ${m.join(", ")} (install the Inngest integration on Vercel)` : "cloud keys set");
}

// --- Platforms ----------------------------------------------------------------------------------
const platform = (name: string, keys: string[], note = "") => {
  const m = missing(...keys);
  if (m.length === keys.length) add("off", name, `not configured (${keys.join(", ")}); its Connect button stays disabled`);
  else if (m.length) add("fail", name, `missing ${m.join(", ")}`);
  else add("ok", name, `configured${note}`);
};
platform("Instagram", ["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"], env("INSTAGRAM_CONFIG_ID") ? " (unified login: Meta App ID/secret + configuration ID)" : " (Instagram login)");
platform("YouTube", ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
const liExtra = env("LINKEDIN_EXTRA_SCOPES");
platform("LinkedIn", ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"], liExtra ? ` (extra scopes: ${liExtra})` : " (publishing only; stats and comments need LinkedIn's Community Management API approval)");
platform("X (optional)", ["TWITTER_CLIENT_ID", "TWITTER_CLIENT_SECRET"]);
if (!["INSTAGRAM_APP_ID", "GOOGLE_CLIENT_ID", "LINKEDIN_CLIENT_ID", "TWITTER_CLIENT_ID"].some((k) => env(k))) add("fail", "Platforms", "no platform is configured, so nothing can be connected");

// --- Legal pages --------------------------------------------------------------------------------
add(env("NEXT_PUBLIC_CONTACT_EMAIL") ? "ok" : "warn", "Privacy & terms", env("NEXT_PUBLIC_CONTACT_EMAIL") ? "contact email set" : "NEXT_PUBLIC_CONTACT_EMAIL missing: Meta and Google reviewers expect a contact address on the privacy page");

// --- Report -------------------------------------------------------------------------------------
const icon: Record<Status, string> = { ok: "\x1b[32m✓\x1b[0m", warn: "\x1b[33m!\x1b[0m", fail: "\x1b[31m✗\x1b[0m", off: "\x1b[2m–\x1b[0m" };
console.log("\nSocial Copilot: setup check\n");
const width = Math.max(...rows.map((r) => r.area.length));
for (const r of rows) console.log(`  ${icon[r.status]} ${r.area.padEnd(width)}  ${r.detail}`);

const url = (p: string) => `${appUrl}${p}`;
console.log(`
Register these exact URLs (copy and paste):

  Clerk  > Webhooks > Add endpoint            ${url("/api/webhooks/clerk")}   (events: user.*)

  Meta   > your app > Instagram > API setup with Unified login (new apps) > Redirect URL
           or, older apps: API setup with Instagram login > Business login settings
           OAuth redirect URI                 ${url("/api/oauth/instagram/callback")}
           Deauthorize callback URL           ${url("/api/meta/deauthorize")}
           Data deletion request URL          ${url("/api/meta/data-deletion")}
  Meta   > App settings > Basic
           Privacy policy URL                 ${url("/privacy")}
           Terms of service URL               ${url("/terms")}
           User data deletion (callback URL)  ${url("/api/meta/data-deletion")}

  Google > Credentials > OAuth client (Web)
           Authorized redirect URI            ${url("/api/oauth/youtube/callback")}
           Authorized JavaScript origin       ${appUrl}
  Google > OAuth consent screen
           Home page / Privacy / Terms        ${appUrl}  ${url("/privacy")}  ${url("/terms")}

  LinkedIn > your app > Auth
           Authorized redirect URL            ${url("/api/oauth/linkedin/callback")}

  X      > User authentication settings
           Callback URI                       ${url("/api/oauth/twitter/callback")}

  Inngest  app endpoint (synced by the Vercel integration)   ${url("/api/inngest")}
  Uptime   health check                                       ${url("/api/health")}
`);

const failed = rows.filter((r) => r.status === "fail").length;
const warned = rows.filter((r) => r.status === "warn").length;
console.log(failed ? `\x1b[31m${failed} problem(s) to fix\x1b[0m${warned ? `, ${warned} warning(s)` : ""}. See SETUP_CHECKLIST.md.\n` : `Ready${warned ? ` (${warned} warning(s))` : ""}. See SETUP_CHECKLIST.md for the console steps.\n`);
process.exit(failed ? 1 : 0);
