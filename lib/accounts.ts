import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { AccountStatus, Platform } from "@/lib/constants";
import { decryptOptional, encrypt, encryptOptional, decrypt } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { postTargets, posts, socialAccounts, type SocialAccount } from "@/lib/db/schema";
import { getAdapter } from "@/lib/platforms";
import { platformName } from "@/lib/platforms/meta";
import { PlatformError, type AccountCapabilities, type AccountProfile, type AdapterAccount, type TokenSet } from "@/lib/platforms/types";

/** What the browser may see about an account. Never includes tokens. */
export interface PublicAccount {
  id: string;
  platform: Platform;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  status: AccountStatus;
  createdAt: string;
  /** When the connection stops working unless renewed. */
  tokenExpiresAt: string | null;
  /** False when only the user can renew it (LinkedIn): the UI warns before it expires. */
  autoRenews: boolean;
  capabilities: AccountCapabilities;
}

export function toPublicAccount(row: SocialAccount): PublicAccount {
  const adapter = getAdapter(row.platform as Platform);
  return {
    id: row.id,
    platform: row.platform as Platform,
    username: row.username,
    displayName: row.displayName,
    profileImageUrl: row.profileImageUrl,
    status: row.status as AccountStatus,
    createdAt: row.createdAt.toISOString(),
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    // Whether a refresh token exists is visible without decrypting it.
    autoRenews: row.tokenExpiresAt === null || (adapter.canRefresh?.({ refreshToken: row.refreshToken }) ?? row.refreshToken !== null),
    capabilities: adapter.capabilities?.({ scopes: row.scopes }) ?? { metrics: Boolean(adapter.fetchMetrics), comments: Boolean(adapter.fetchComments) },
  };
}

export async function listAccounts(userId: string): Promise<PublicAccount[]> {
  const rows = await getDb().select().from(socialAccounts).where(eq(socialAccounts.userId, userId)).orderBy(socialAccounts.createdAt);
  return rows.map(toPublicAccount);
}

export function toAdapterAccount(row: SocialAccount): AdapterAccount {
  return {
    id: row.id,
    platform: row.platform as Platform,
    platformAccountId: row.platformAccountId,
    username: row.username,
    displayName: row.displayName,
    accessToken: decrypt(row.accessToken),
    refreshToken: decryptOptional(row.refreshToken),
    tokenExpiresAt: row.tokenExpiresAt,
    scopes: row.scopes,
    metadata: row.metadata ?? {},
  };
}

/** Insert or update the account after a successful OAuth exchange (real profile, encrypted tokens). */
export async function saveConnectedAccount(userId: string, platform: Platform, data: TokenSet & AccountProfile) {
  const values = {
    userId,
    platform,
    platformAccountId: data.platformAccountId,
    username: data.username,
    displayName: data.displayName,
    profileImageUrl: data.profileImageUrl,
    accessToken: encrypt(data.accessToken),
    refreshToken: encryptOptional(data.refreshToken),
    tokenExpiresAt: data.expiresAt ?? null,
    scopes: data.scopes ?? null,
    status: "connected",
    metadata: data.metadata ?? {},
  };
  const [row] = await getDb()
    .insert(socialAccounts)
    .values(values)
    .onConflictDoUpdate({
      target: [socialAccounts.userId, socialAccounts.platform, socialAccounts.platformAccountId],
      set: {
        username: values.username,
        displayName: values.displayName,
        profileImageUrl: values.profileImageUrl,
        accessToken: values.accessToken,
        // Keep the old refresh token if the platform did not issue a new one.
        refreshToken: values.refreshToken ?? sql`${socialAccounts.refreshToken}`,
        tokenExpiresAt: values.tokenExpiresAt,
        scopes: values.scopes,
        status: "connected",
        metadata: values.metadata,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export async function setAccountStatus(accountId: string, status: AccountStatus) {
  await getDb().update(socialAccounts).set({ status, updatedAt: new Date() }).where(eq(socialAccounts.id, accountId));
}

/** Refresh when the access token expires within this window (adapters may ask for more, e.g. Instagram). */
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

function needsRefresh(row: SocialAccount, now = Date.now()): boolean {
  if (row.tokenExpiresAt === null) return false;
  const adapter = getAdapter(row.platform as Platform);
  // A token that cannot be renewed (LinkedIn) is used until it really expires; then refreshToken() says "reconnect".
  return row.tokenExpiresAt.getTime() - now < (adapter.refreshWindowMs ?? REFRESH_WINDOW_MS);
}

/**
 * Returns an account with a valid access token, refreshing first if needed.
 *
 * X rotates refresh tokens (each is single use), so two concurrent refreshes would
 * invalidate each other. A transaction-scoped advisory lock serializes them: the
 * second caller re-reads the row and finds a fresh token.
 */
export async function getUsableAccount(accountId: string): Promise<AdapterAccount> {
  const db = getDb();
  const [row] = await db.select().from(socialAccounts).where(eq(socialAccounts.id, accountId)).limit(1);
  if (!row) throw new PlatformError("This account was disconnected.", "validation", false);
  const label = `${platformName(row.platform)} ${row.username ? `@${row.username}` : "account"}`;
  if (row.status !== "connected") throw new PlatformError(`${label} needs to be reconnected.`, "auth", false);
  if (!needsRefresh(row)) return toAdapterAccount(row);

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${accountId}, 0))`);
    const [fresh] = await tx.select().from(socialAccounts).where(eq(socialAccounts.id, accountId)).limit(1);
    if (!fresh) return { error: new PlatformError("This account was disconnected.", "validation", false) };
    if (!needsRefresh(fresh)) return { account: toAdapterAccount(fresh) };

    try {
      const t = await getAdapter(fresh.platform as Platform).refreshToken(toAdapterAccount(fresh));
      const [saved] = await tx
        .update(socialAccounts)
        .set({
          accessToken: encrypt(t.accessToken),
          refreshToken: t.refreshToken ? encrypt(t.refreshToken) : fresh.refreshToken,
          tokenExpiresAt: t.expiresAt ?? null,
          scopes: t.scopes ?? fresh.scopes,
          updatedAt: new Date(),
        })
        .where(eq(socialAccounts.id, accountId))
        .returning();
      return { account: toAdapterAccount(saved) };
    } catch (e) {
      if (e instanceof PlatformError && e.kind === "auth") {
        // Commit the status change so the UI shows "Reconnect".
        await tx.update(socialAccounts).set({ status: "expired", updatedAt: new Date() }).where(eq(socialAccounts.id, accountId));
        return { error: new PlatformError(`${label} needs to be reconnected (${e.message}).`, "auth", false) };
      }
      return { error: e };
    }
  });

  if ("error" in outcome) throw outcome.error;
  return outcome.account;
}

/**
 * Daily: renew tokens that are close to expiry even if the account is idle (an Instagram token that is
 * not refreshed within 60 days is gone for good), and mark dead ones so the UI asks for a reconnect.
 */
export async function refreshExpiringAccounts(now = new Date()): Promise<{ checked: number; refreshed: number; failed: { accountId: string; reason: string }[] }> {
  const rows = await getDb()
    .select()
    .from(socialAccounts)
    .where(and(eq(socialAccounts.status, "connected"), sql`${socialAccounts.tokenExpiresAt} is not null`, sql`${socialAccounts.tokenExpiresAt} < ${new Date(now.getTime() + 30 * 86_400_000)}`));
  const out = { checked: 0, refreshed: 0, failed: [] as { accountId: string; reason: string }[] };
  for (const row of rows) {
    if (!needsRefresh(row, now.getTime())) continue;
    out.checked += 1;
    try {
      const before = row.tokenExpiresAt?.getTime();
      const fresh = await getUsableAccount(row.id);
      if (fresh.tokenExpiresAt?.getTime() !== before) out.refreshed += 1;
    } catch (e) {
      out.failed.push({ accountId: row.id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** Posts that are still going to be published to this account. */
export async function countPendingTargets(accountId: string): Promise<number> {
  const [r] = await getDb()
    .select({ n: count() })
    .from(postTargets)
    .innerJoin(posts, eq(posts.id, postTargets.postId))
    .where(and(eq(postTargets.socialAccountId, accountId), inArray(posts.status, ["scheduled", "publishing"])));
  return r?.n ?? 0;
}
