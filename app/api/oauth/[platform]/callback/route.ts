import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { saveConnectedAccount } from "@/lib/accounts";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { socialAccounts } from "@/lib/db/schema";
import { appUrl } from "@/lib/env";
import { AppError, ConfigError } from "@/lib/errors";
import { openOAuthCookie, oauthCookieName, safeEqual } from "@/lib/oauth";
import { getAdapter, isPlatform } from "@/lib/platforms";
import { PlatformError } from "@/lib/platforms/types";
import { assertCanConnectAccount } from "@/lib/plans";

export const runtime = "nodejs";

function backToAccounts(params: Record<string, string>) {
  const url = new URL("/dashboard/accounts", appUrl());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

/**
 * OAuth callback. The route path MUST equal the redirect URI registered with the
 * platform: /api/oauth/<platform>/callback (a mismatch is the classic "something
 * went wrong" failure).
 */
export async function GET(req: Request, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  const url = new URL(req.url);

  if (!isPlatform(platform)) return backToAccounts({ error: "unknown_platform" });
  const adapter = getAdapter(platform);
  if (!adapter.implemented) return backToAccounts({ error: "coming_soon", platform });

  const store = await cookies();
  const cookieName = oauthCookieName(platform);
  const sealed = openOAuthCookie(store.get(cookieName)?.value);
  store.delete({ name: cookieName, path: "/api/oauth" }); // single use, success or not

  if (url.searchParams.get("error")) return backToAccounts({ error: "denied", platform });
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return backToAccounts({ error: "invalid_callback", platform });
  if (!sealed) return backToAccounts({ error: "state_missing", platform });
  if (!safeEqual(sealed.state, state)) return backToAccounts({ error: "state_mismatch", platform });

  try {
    const session = await requireUser();
    if (session.user.id !== sealed.userId) return backToAccounts({ error: "session_mismatch", platform });

    const profile = await adapter.exchangeCode({
      code,
      codeVerifier: sealed.verifier,
      redirectUri: `${appUrl()}/api/oauth/${platform}/callback`,
    });

    // The plan limit applies to NEW accounts only; re-authorizing an existing one is always allowed.
    const [existing] = await getDb()
      .select({ id: socialAccounts.id })
      .from(socialAccounts)
      .where(
        and(
          eq(socialAccounts.userId, session.user.id),
          eq(socialAccounts.platform, platform),
          eq(socialAccounts.platformAccountId, profile.platformAccountId),
        ),
      )
      .limit(1);
    if (!existing) await assertCanConnectAccount(session.user.id, session.plan);

    await saveConnectedAccount(session.user.id, platform, profile);
    return backToAccounts({ connected: platform });
  } catch (e) {
    if (e instanceof AppError && e.status === 401) return NextResponse.redirect(new URL("/sign-in", appUrl()));
    if (e instanceof AppError && e.code === "PLAN_LIMIT") return backToAccounts({ error: "plan_limit", platform });
    if (e instanceof ConfigError) return backToAccounts({ error: "not_configured", platform });
    if (e instanceof PlatformError) {
      console.warn(`[oauth:callback] ${platform} exchange failed: ${e.message}`);
      return backToAccounts({ error: "token_exchange", platform, detail: e.message.slice(0, 200) });
    }
    console.error("[oauth:callback] failed", e);
    return backToAccounts({ error: "internal", platform });
  }
}
