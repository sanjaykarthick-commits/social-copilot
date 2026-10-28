import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasDb, resetDb } from "./helpers/db";

// Deterministic adapter so we can count refresh calls. Everything else is the real code.
const refreshToken = vi.fn();
vi.mock("@/lib/platforms", async (orig) => {
  const real = await orig<typeof import("@/lib/platforms")>();
  return {
    ...real,
    getAdapter: (p: string) => (p === "twitter" ? { platform: "twitter", implemented: true, refreshToken } : real.getAdapter(p as never)),
  };
});

import { getDb } from "@/lib/db";
import { socialAccounts } from "@/lib/db/schema";
import { getUsableAccount, saveConnectedAccount, toPublicAccount } from "@/lib/accounts";
import { decrypt } from "@/lib/crypto";
import { PlatformError } from "@/lib/platforms/types";
import { upsertUser } from "@/lib/users";

const profile = (over: object = {}) => ({
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: new Date(Date.now() + 2 * 3600_000),
  scopes: "tweet.read tweet.write",
  platformAccountId: "123",
  username: "asha",
  displayName: "Asha",
  profileImageUrl: "https://pbs.twimg.com/a.jpg",
  ...over,
});

describe.skipIf(!hasDb)("social accounts", () => {
  let userId: string;
  beforeEach(async () => {
    await resetDb();
    refreshToken.mockReset();
    userId = (await upsertUser("user_acct")).id;
  });
  afterAll(resetDb);

  it("stores real profile data and encrypts tokens at rest", async () => {
    const row = await saveConnectedAccount(userId, "twitter", profile());
    expect(row).toMatchObject({ username: "asha", displayName: "Asha", status: "connected", platformAccountId: "123" });
    expect(row.accessToken).not.toContain("access-1");
    expect(row.refreshToken).not.toContain("refresh-1");
    expect(decrypt(row.accessToken)).toBe("access-1");
    expect(decrypt(row.refreshToken!)).toBe("refresh-1");
  });

  it("never exposes tokens through the public shape", () => {
    const pub = toPublicAccount({ id: "x", userId, platform: "twitter", platformAccountId: "1", username: "a", displayName: "A", profileImageUrl: null, accessToken: "enc", refreshToken: "enc", tokenExpiresAt: null, scopes: null, status: "connected", lastCommentSyncAt: null, metadata: {}, createdAt: new Date(), updatedAt: new Date() });
    expect(JSON.stringify(pub)).not.toContain("enc");
    expect(Object.keys(pub)).not.toContain("accessToken");
  });

  it("reconnecting the same account updates it instead of duplicating", async () => {
    await saveConnectedAccount(userId, "twitter", profile());
    await saveConnectedAccount(userId, "twitter", profile({ accessToken: "access-2", username: "asha_new" }));
    const rows = await getDb().select().from(socialAccounts);
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe("asha_new");
    expect(decrypt(rows[0].accessToken)).toBe("access-2");
  });

  it("keeps the old refresh token when reconnecting without a new one", async () => {
    await saveConnectedAccount(userId, "twitter", profile());
    await saveConnectedAccount(userId, "twitter", profile({ refreshToken: null }));
    const [row] = await getDb().select().from(socialAccounts);
    expect(decrypt(row.refreshToken!)).toBe("refresh-1");
  });

  it("returns decrypted tokens without refreshing when the token is fresh", async () => {
    const row = await saveConnectedAccount(userId, "twitter", profile());
    const acct = await getUsableAccount(row.id);
    expect(acct.accessToken).toBe("access-1");
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("refreshes an expiring token and stores the rotated refresh token", async () => {
    const row = await saveConnectedAccount(userId, "twitter", profile({ expiresAt: new Date(Date.now() + 60_000) }));
    refreshToken.mockResolvedValue({ accessToken: "access-2", refreshToken: "refresh-2", expiresAt: new Date(Date.now() + 2 * 3600_000) });
    const acct = await getUsableAccount(row.id);
    expect(acct).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
    const [saved] = await getDb().select().from(socialAccounts).where(eq(socialAccounts.id, row.id));
    expect(decrypt(saved.refreshToken!)).toBe("refresh-2");
  });

  it("serializes concurrent refreshes: the platform is called once (refresh tokens are single use)", async () => {
    const row = await saveConnectedAccount(userId, "twitter", profile({ expiresAt: new Date(Date.now() + 60_000) }));
    refreshToken.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 150));
      return { accessToken: "access-2", refreshToken: "refresh-2", expiresAt: new Date(Date.now() + 2 * 3600_000) };
    });
    const results = await Promise.all([getUsableAccount(row.id), getUsableAccount(row.id), getUsableAccount(row.id)]);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(results.every((a) => a.accessToken === "access-2")).toBe(true);
  });

  it("marks the account expired when the refresh is rejected, and says to reconnect", async () => {
    const row = await saveConnectedAccount(userId, "twitter", profile({ expiresAt: new Date(Date.now() + 60_000) }));
    refreshToken.mockRejectedValue(new PlatformError("invalid grant", "auth", false));
    await expect(getUsableAccount(row.id)).rejects.toMatchObject({ kind: "auth", message: expect.stringContaining("reconnected") });
    const [saved] = await getDb().select().from(socialAccounts).where(eq(socialAccounts.id, row.id));
    expect(saved.status).toBe("expired");
    // and it stays unusable until the user reconnects
    await expect(getUsableAccount(row.id)).rejects.toMatchObject({ kind: "auth" });
  });

  it("transient refresh failures do not expire the account", async () => {
    const row = await saveConnectedAccount(userId, "twitter", profile({ expiresAt: new Date(Date.now() + 60_000) }));
    refreshToken.mockRejectedValue(new PlatformError("X is down", "api", true));
    await expect(getUsableAccount(row.id)).rejects.toMatchObject({ retryable: true });
    const [saved] = await getDb().select().from(socialAccounts).where(eq(socialAccounts.id, row.id));
    expect(saved.status).toBe("connected");
  });
});
