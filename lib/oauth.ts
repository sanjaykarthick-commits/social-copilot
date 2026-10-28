import { createHash, randomBytes } from "node:crypto";
import { decrypt, encrypt } from "@/lib/crypto";

const b64url = (buf: Buffer) => buf.toString("base64url");

/** RFC 7636: challenge = BASE64URL(SHA256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}

export function newOAuthSession() {
  const verifier = b64url(randomBytes(48)); // 64 chars, within the 43-128 limit
  return { state: b64url(randomBytes(24)), verifier, challenge: pkceChallenge(verifier) };
}

export interface OAuthCookiePayload {
  state: string;
  verifier: string;
  userId: string;
  /** Account being reconnected, if any. */
  reconnectId?: string;
  createdAt: number;
}

export const OAUTH_COOKIE_MAX_AGE_S = 600;
export const oauthCookieName = (platform: string) => `sc_oauth_${platform}`;

/** The PKCE verifier never reaches the browser in the clear: the cookie is AES-GCM sealed. */
export const sealOAuthCookie = (p: OAuthCookiePayload) => encrypt(JSON.stringify(p));

export function openOAuthCookie(value: string | undefined, now = Date.now()): OAuthCookiePayload | null {
  if (!value) return null;
  try {
    const p = JSON.parse(decrypt(value)) as OAuthCookiePayload;
    if (!p.state || !p.verifier || !p.userId) return null;
    if (now - p.createdAt > OAUTH_COOKIE_MAX_AGE_S * 1000) return null;
    return p;
  } catch {
    return null;
  }
}

/** Constant-time string comparison for the `state` check. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i += 1) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
