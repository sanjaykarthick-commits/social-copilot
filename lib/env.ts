import { z } from "zod";
import { ConfigError } from "@/lib/errors";

/**
 * Environment is validated lazily, per feature. The app must still build and
 * serve public pages without secrets; a route that needs a missing variable
 * fails with a readable CONFIG_MISSING error instead of crashing the process.
 */
const str = z.string().trim().min(1).optional();

const schema = z.object({
  NEXT_PUBLIC_APP_URL: z.url().default("http://localhost:3000"),

  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: str,
  CLERK_SECRET_KEY: str,
  CLERK_WEBHOOK_SECRET: str,

  DATABASE_URL: str,
  TOKEN_ENCRYPTION_KEY: str,

  TWITTER_CLIENT_ID: str,
  TWITTER_CLIENT_SECRET: str,

  GOOGLE_CLIENT_ID: str,
  GOOGLE_CLIENT_SECRET: str,

  /**
   * Instagram login: the Instagram app ID/secret from Meta's "API setup with Instagram login" page.
   * Unified login (new Meta apps): the Meta App ID/secret from App settings > Basic, plus INSTAGRAM_CONFIG_ID.
   */
  INSTAGRAM_APP_ID: str,
  INSTAGRAM_APP_SECRET: str,
  /** Configuration ID from Meta's "API setup with Unified login" page. When set, unified login is used. */
  INSTAGRAM_CONFIG_ID: str,
  /** Unified login stopgap: an Instagram account id to try when Meta's token does not list its accounts. */
  INSTAGRAM_ACCOUNT_ID: str,

  LINKEDIN_CLIENT_ID: str,
  LINKEDIN_CLIENT_SECRET: str,
  /** LinkedIn-Version header (YYYYMM). Each version is supported for about a year. */
  LINKEDIN_API_VERSION: z.string().regex(/^\d{6}$/).optional(),
  /** Extra scopes your LinkedIn app was approved for, e.g. "r_member_social r_member_postAnalytics". */
  LINKEDIN_EXTRA_SCOPES: str,

  /** Shown on the privacy and terms pages. */
  NEXT_PUBLIC_CONTACT_EMAIL: str,

  GEMINI_API_KEY: str,
  GEMINI_MODEL: str,

  NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY: str,
  IMAGEKIT_PRIVATE_KEY: str,
  NEXT_PUBLIC_IMAGEKIT_URL_ENDPOINT: str,

  INNGEST_DEV: str,
  INNGEST_EVENT_KEY: str,
  INNGEST_SIGNING_KEY: str,

  PLUNK_API_KEY: str,
});

export type Env = z.infer<typeof schema>;
export type EnvKey = keyof Env;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  // Treat `KEY=` (empty) in .env files as unset.
  const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ""));
  cached = schema.parse(raw);
  return cached;
}

/** Test helper. */
export function resetEnvCache() {
  cached = undefined;
}

/** Returns the named variables or throws ConfigError listing every missing one. */
export function requireEnv<K extends EnvKey>(...keys: K[]): { [P in K]: NonNullable<Env[P]> } {
  const env = getEnv();
  const missing = keys.filter((k) => env[k] === undefined);
  if (missing.length) throw new ConfigError(missing);
  return Object.fromEntries(keys.map((k) => [k, env[k]])) as { [P in K]: NonNullable<Env[P]> };
}

export function isConfigured(...keys: EnvKey[]): boolean {
  const env = getEnv();
  return keys.every((k) => env[k] !== undefined);
}

export const appUrl = () => getEnv().NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
