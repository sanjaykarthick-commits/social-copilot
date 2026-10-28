import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { socialAccounts } from "@/lib/db/schema";

/**
 * Meta's deauthorize and data-deletion callbacks send `signed_request` = base64url(signature).base64url(payload),
 * where signature = HMAC-SHA256(payload part, app secret). Anything that does not verify is rejected.
 */
export function parseSignedRequest(signedRequest: string, secret: string): { user_id: string; algorithm?: string; issued_at?: number } | null {
  const [sigPart, payloadPart] = signedRequest.split(".", 2);
  if (!sigPart || !payloadPart) return null;
  const expected = createHmac("sha256", secret).update(payloadPart).digest();
  const given = Buffer.from(sigPart, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    if (payload?.algorithm && String(payload.algorithm).toUpperCase() !== "HMAC-SHA256") return null;
    if (payload?.user_id === undefined || payload.user_id === null) return null;
    return { ...payload, user_id: String(payload.user_id) };
  } catch {
    return null;
  }
}

/** Meta may identify the person by the Instagram account id or by the app-scoped id. */
const instagramUser = (userId: string) =>
  and(eq(socialAccounts.platform, "instagram"), or(eq(socialAccounts.platformAccountId, userId), sql`${socialAccounts.metadata}->>'appScopedId' = ${userId}`));

/** The person removed the app in Instagram: stop using the token right away. */
export async function revokeInstagramUser(userId: string): Promise<number> {
  const rows = await getDb().update(socialAccounts).set({ status: "revoked", updatedAt: new Date() }).where(instagramUser(userId)).returning({ id: socialAccounts.id });
  return rows.length;
}

/** The person asked Meta to delete their data: remove the connection, its tokens, its comments and its post targets. */
export async function deleteInstagramUser(userId: string): Promise<number> {
  const rows = await getDb().delete(socialAccounts).where(instagramUser(userId)).returning({ id: socialAccounts.id });
  return rows.length;
}
