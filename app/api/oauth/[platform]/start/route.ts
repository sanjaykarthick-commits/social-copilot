import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { appUrl } from "@/lib/env";
import { AppError, ConfigError } from "@/lib/errors";
import { getDb } from "@/lib/db";
import { socialAccounts } from "@/lib/db/schema";
import { newOAuthSession, OAUTH_COOKIE_MAX_AGE_S, oauthCookieName, sealOAuthCookie } from "@/lib/oauth";
import { getAdapter, isPlatform } from "@/lib/platforms";
import { assertCanConnectAccount } from "@/lib/plans";

export const runtime = "nodejs";

function backToAccounts(params: Record<string, string>) {
  const url = new URL("/dashboard/accounts", appUrl());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

/**
 * Begin OAuth: create state + PKCE verifier, seal them in a short-lived httpOnly
 * cookie, then redirect to the platform. `?reconnect=<accountId>` re-authorizes an
 * existing account without counting against the plan limit.
 */
export async function GET(req: Request, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;

  let session;
  try {
    session = await requireUser();
  } catch (e) {
    if (e instanceof AppError && e.status === 401) return NextResponse.redirect(new URL("/sign-in", appUrl()));
    console.error("[oauth:start] auth failed", e);
    return backToAccounts({ error: "internal" });
  }

  if (!isPlatform(platform)) return backToAccounts({ error: "unknown_platform" });
  const adapter = getAdapter(platform);
  if (!adapter.implemented) return backToAccounts({ error: "coming_soon", platform });

  try {
    const reconnectId = new URL(req.url).searchParams.get("reconnect") ?? undefined;
    if (reconnectId) {
      const [owned] = await getDb()
        .select({ id: socialAccounts.id })
        .from(socialAccounts)
        .where(and(eq(socialAccounts.id, reconnectId), eq(socialAccounts.userId, session.user.id)))
        .limit(1);
      if (!owned) return backToAccounts({ error: "internal" });
    } else {
      await assertCanConnectAccount(session.user.id, session.plan);
    }

    const oauth = newOAuthSession();
    const authUrl = adapter.getAuthUrl({
      state: oauth.state,
      codeChallenge: oauth.challenge,
      redirectUri: `${appUrl()}/api/oauth/${platform}/callback`,
    });

    const store = await cookies();
    store.set(
      oauthCookieName(platform),
      sealOAuthCookie({ state: oauth.state, verifier: oauth.verifier, userId: session.user.id, reconnectId, createdAt: Date.now() }),
      {
        httpOnly: true,
        sameSite: "lax", // must survive the redirect back from the platform
        secure: appUrl().startsWith("https://"),
        path: "/api/oauth",
        maxAge: OAUTH_COOKIE_MAX_AGE_S,
      },
    );
    return NextResponse.redirect(authUrl);
  } catch (e) {
    if (e instanceof ConfigError) return backToAccounts({ error: "not_configured", platform });
    if (e instanceof AppError && e.code === "PLAN_LIMIT") return backToAccounts({ error: "plan_limit" });
    console.error("[oauth:start] failed", e);
    return backToAccounts({ error: "internal" });
  }
}
