import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasDb, resetDb } from "./helpers/db";
import { makeUser } from "./helpers/fixtures";

const DAY = 86_400_000;
const igRefresh = vi.fn();
const liRefresh = vi.fn();
vi.mock("@/lib/platforms", async (orig) => {
  const real = await orig<typeof import("@/lib/platforms")>();
  const ig = real.getAdapter("instagram");
  const li = real.getAdapter("linkedin");
  return {
    ...real,
    // The real adapters' refresh policy (windows, canRefresh), with the network call faked.
    getAdapter: (p: string) =>
      p === "instagram" ? { ...ig, refreshToken: igRefresh } : p === "linkedin" ? { ...li, refreshToken: liRefresh } : real.getAdapter(p as never),
  };
});

import { getUsableAccount, refreshExpiringAccounts, saveConnectedAccount, toPublicAccount } from "@/lib/accounts";
import { getDb } from "@/lib/db";
import { socialAccounts } from "@/lib/db/schema";
import { PlatformError } from "@/lib/platforms/types";

describe.skipIf(!hasDb)("token renewal policy", () => {
  let userId: string;
  beforeEach(async () => {
    await resetDb();
    igRefresh.mockReset();
    liRefresh.mockReset();
    userId = (await makeUser("user_t")).id;
  });
  afterAll(resetDb);

  const connect = (platform: "instagram" | "linkedin", expiresInDays: number, refreshToken: string | null = null, scopes = "") =>
    saveConnectedAccount(userId, platform, {
      accessToken: `tok-${platform}`,
      refreshToken,
      expiresAt: new Date(Date.now() + expiresInDays * DAY),
      scopes,
      platformAccountId: `pid-${platform}-${expiresInDays}`,
      username: platform,
      displayName: null,
      profileImageUrl: null,
    });

  it("Instagram tokens are renewed weeks before they expire (they cannot be renewed once expired)", async () => {
    const fresh = await connect("instagram", 50);
    const old = await connect("instagram", 10);
    igRefresh.mockResolvedValue({ accessToken: "renewed", refreshToken: null, expiresAt: new Date(Date.now() + 60 * DAY) });

    expect((await getUsableAccount(fresh.id)).accessToken).toBe("tok-instagram");
    expect(igRefresh).not.toHaveBeenCalled();
    const renewed = await getUsableAccount(old.id);
    expect(renewed.accessToken).toBe("renewed");
    expect(renewed.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * DAY);
  });

  it("LinkedIn tokens without a refresh token are used until they run out, then the account asks for a reconnect", async () => {
    const soon = await connect("linkedin", 3);
    expect((await getUsableAccount(soon.id)).accessToken).toBe("tok-linkedin");
    expect(liRefresh).not.toHaveBeenCalled();

    await getDb().update(socialAccounts).set({ tokenExpiresAt: new Date(Date.now() + 60_000) }).where(eq(socialAccounts.id, soon.id));
    liRefresh.mockRejectedValue(new PlatformError("LinkedIn connections last 60 days. Reconnect LinkedIn.", "auth", false));
    await expect(getUsableAccount(soon.id)).rejects.toMatchObject({ kind: "auth" });
    expect((await getDb().select().from(socialAccounts).where(eq(socialAccounts.id, soon.id)))[0].status).toBe("expired");
  });

  it("the daily job renews idle Instagram accounts and reports failures without stopping", async () => {
    const a = await connect("instagram", 5);
    const b = await connect("instagram", 6);
    await connect("instagram", 55); // not due
    await connect("linkedin", 5); // cannot be renewed: left alone
    igRefresh.mockImplementation(async (acc: { id: string }) => {
      if (acc.id === b.id) throw new PlatformError("Session has expired", "auth", false);
      return { accessToken: "renewed", refreshToken: null, expiresAt: new Date(Date.now() + 60 * DAY) };
    });
    const r = await refreshExpiringAccounts();
    expect(r.checked).toBe(2);
    expect(r.refreshed).toBe(1);
    expect(r.failed.map((f) => f.accountId)).toEqual([b.id]);
    expect(liRefresh).not.toHaveBeenCalled();
    const rows = await getDb().select().from(socialAccounts);
    expect(rows.find((x) => x.id === a.id)!.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * DAY);
    expect(rows.find((x) => x.id === b.id)!.status).toBe("expired");
  });

  it("the account card knows what renews by itself and what this connection can do", async () => {
    const ig = toPublicAccount(await connect("instagram", 50, null, "instagram_business_basic,instagram_business_manage_comments"));
    expect(ig).toMatchObject({ autoRenews: true, capabilities: { metrics: true, comments: true } });
    const li = toPublicAccount(await connect("linkedin", 50, null, "openid,profile,w_member_social"));
    expect(li).toMatchObject({ autoRenews: false, capabilities: { metrics: false, comments: false } });
    expect(li.tokenExpiresAt).not.toBeNull();
    expect(JSON.stringify(li)).not.toContain("tok-linkedin");
  });
});
