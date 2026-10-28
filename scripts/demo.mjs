/**
 * One command to see the whole app running locally, with no accounts or keys:
 *
 *   docker compose up -d db      # a local Postgres (or point DATABASE_URL at your own LOCAL one)
 *   npm install
 *   npm run demo                 # then open http://localhost:3000
 *
 * It creates the tables, loads a demo account with sample posts, and starts the app and the scheduler.
 * Sign-in is replaced by a built-in demo user (tests/e2e/fake-clerk). That stand-in only exists in this
 * mode; production builds never include it. X and YouTube are fake connections, so "Post now" will fail
 * with the platform's error; scheduling, the calendar, drag and drop and analytics all work for real.
 *
 * WARNING: this resets the demo database (truncates the users table and everything under it).
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const PORT = process.env.PORT ?? "3000";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://sc:sc@localhost:5432/social_copilot";
const withScheduler = process.env.NO_SCHEDULER !== "1";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL)) {
  console.error("Refusing to run the demo against a non-local database (it resets the data):\n  " + DATABASE_URL.replace(/:[^:@/]*@/, ":***@"));
  process.exit(2);
}

const env = {
  ...process.env,
  DATABASE_URL,
  E2E_FAKE_AUTH: "1",
  INNGEST_DEV: "1",
  NEXT_PUBLIC_APP_URL: `http://localhost:${PORT}`,
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"), // demo-only key
  TWITTER_CLIENT_ID: "demo",
  TWITTER_CLIENT_SECRET: "demo",
  GOOGLE_CLIENT_ID: "demo",
  GOOGLE_CLIENT_SECRET: "demo",
  INSTAGRAM_APP_ID: "demo",
  INSTAGRAM_APP_SECRET: "demo",
  LINKEDIN_CLIENT_ID: "demo",
  LINKEDIN_CLIENT_SECRET: "demo",
  DEMO_ASSET_BASE: `http://localhost:${PORT}/demo`,
};

// 1. Is Postgres reachable?
const { Client } = require("pg");
const probe = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 4000 });
try {
  await probe.connect();
  await probe.end();
} catch (e) {
  console.error(`\nCannot reach Postgres at ${DATABASE_URL.replace(/:[^:@/]*@/, ":***@")}\n  (${e.message})\n`);
  console.error("Start one with:  docker compose up -d db\nor set DATABASE_URL to a LOCAL Postgres you control, then run `npm run demo` again.\n");
  process.exit(1);
}

// 2. Demo media (images + a short clip) served from /demo
mkdirSync(path.join(root, "public", "demo"), { recursive: true });
cpSync(path.join(root, "scripts", "demo-assets"), path.join(root, "public", "demo"), { recursive: true });

/** Path to a package's CLI file. Some packages hide it behind `exports`, so go through node_modules directly. */
function bin(pkg, rel) {
  const file = path.join(root, "node_modules", pkg, rel);
  if (!existsSync(file)) {
    console.error(`\nMissing ${file}\nRun \`npm install\` first.`);
    process.exit(1);
  }
  return file;
}

// 3. Tables + demo data (run with this same Node so it works on Windows, macOS and Linux)
function run(label, script, args = []) {
  console.log(`\n> ${label}`);
  const r = spawnSync(process.execPath, [script, ...args], { cwd: root, env, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n"${label}" failed.`);
    process.exit(r.status ?? 1);
  }
}
run("Creating tables", bin("drizzle-kit", "bin.cjs"), ["push", "--force"]);
run("Loading demo data", bin("tsx", "dist/cli.mjs"), ["scripts/seed-demo.mts"]);

// 4. App + scheduler
const children = [];
const start = (name, cmd, args, opts = {}) => {
  const c = spawn(cmd, args, { cwd: root, env, stdio: "inherit", ...opts });
  c.on("exit", (code) => {
    if (code && !shuttingDown) console.error(`\n${name} stopped (exit ${code}).`);
  });
  children.push(c);
};
let shuttingDown = false;
const stop = () => {
  shuttingDown = true;
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

start("app", process.execPath, [bin("next", "dist/bin/next"), "dev", "-p", PORT]);
if (withScheduler) {
  // The scheduler is the Inngest dev server (downloaded on first use by npx).
  start("scheduler", "npx", ["--yes", "inngest-cli@latest", "dev", "-u", `http://127.0.0.1:${PORT}/api/inngest`, "--no-discovery", "-p", "8288"], { shell: true });
}

setTimeout(() => {
  console.log(`\n==============================================================\n  Social Copilot demo:  http://localhost:${PORT}\n  Scheduler dashboard:  http://localhost:8288${withScheduler ? "" : " (disabled)"}\n  Press Ctrl+C to stop.\n==============================================================\n`);
}, 6000);
