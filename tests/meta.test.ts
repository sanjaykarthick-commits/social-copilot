import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { saveConnectedAccount } from "@/lib/accounts";
import { getDb } from "@/lib/db";
import { socialAccounts } from "@/lib/db/schema";
import { deleteInstagramUser, parseSignedRequest, revokeInstagramUser } from "@/lib/meta";
import { hasDb, resetDb } from "./helpers/db";
import { makeAccount, makeUser } from "./helpers/fixtures";

const SECRET = "test-ig-secret";
function sign(payload: object, secret = SECRET) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${sig}.${body}`;
}

describe("Meta signed_request", () => {
  it("accepts a correctly signed request and returns the user id as a string", () => {
    expect(parseSignedRequest(sign({ algorithm: "HMAC-SHA256", issued_at: 1, user_id: 17841400000 }), SECRET)).toMatchObject({ user_id: "17841400000" });
  });
  it("rejects a wrong secret, a tampered payload, a wrong algorithm and garbage", () => {
    expect(parseSignedRequest(sign({ user_id: "1" }, "other"), SECRET)).toBeNull();
    const [sig] = sign({ user_id: "1" }).split(".");
    expect(parseSignedRequest(`${sig}.${Buffer.from(JSON.stringify({ user_id: "2" })).toString("base64url")}`, SECRET)).toBeNull();
    expect(parseSignedRequest(sign({ algorithm: "none", user_id: "1" }), SECRET)).toBeNull();
    expect(parseSignedRequest("not-a-signed-request", SECRET)).toBeNull();
    expect(parseSignedRequest(sign({ issued_at: 1 }), SECRET)).toBeNull();
  });
});

describe.skipIf(!hasDb)("Meta deauthorize / data deletion", () => {
  beforeEach(resetDb);
  afterAll(resetDb);

  it("revokes or deletes only the matching Instagram connection (by IG id or app-scoped id)", async () => {
    const userId = (await makeUser("user_meta")).id;
    const ig = await saveConnectedAccount(userId, "instagram", {
      accessToken: "t",
      platformAccountId: "1784",
      username: "a",
      displayName: null,
      profileImageUrl: null,
      metadata: { appScopedId: "app-9" },
    });
    const other = await makeAccount(userId, "youtube", "yt");

    expect(await revokeInstagramUser("app-9")).toBe(1);
    expect((await getDb().select().from(socialAccounts).where(eq(socialAccounts.id, ig.id)))[0].status).toBe("revoked");
    expect(await revokeInstagramUser("nobody")).toBe(0);

    expect(await deleteInstagramUser("1784")).toBe(1);
    const left = await getDb().select().from(socialAccounts);
    expect(left.map((r) => r.id)).toEqual([other.id]);
  });
});
