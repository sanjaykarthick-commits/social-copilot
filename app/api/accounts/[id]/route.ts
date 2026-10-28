import { and, eq } from "drizzle-orm";
import { countPendingTargets, toAdapterAccount } from "@/lib/accounts";
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { socialAccounts } from "@/lib/db/schema";
import { AppError, notFound } from "@/lib/errors";
import { getAdapter } from "@/lib/platforms";
import type { Platform } from "@/lib/constants";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = handle<Ctx>(async (_req, ctx) => {
  const { id } = await ctx.params;
  const { user } = await requireUser();
  const db = getDb();

  const [row] = await db
    .select()
    .from(socialAccounts)
    .where(and(eq(socialAccounts.id, id), eq(socialAccounts.userId, user.id)))
    .limit(1);
  if (!row) throw notFound("Account");

  // Deleting an account cascades to its post targets, which would silently drop
  // scheduled posts. Make the user decide first.
  const pending = await countPendingTargets(id);
  if (pending > 0) {
    throw new AppError(
      "ACCOUNT_IN_USE",
      `${pending} scheduled ${pending === 1 ? "post is" : "posts are"} set to publish to this account. Delete or reschedule ${pending === 1 ? "it" : "them"} first.`,
      409,
      { pending },
    );
  }

  // Best effort: tell the platform to revoke the token. Disconnecting must not fail because of it.
  try {
    await getAdapter(row.platform as Platform).revokeToken?.(toAdapterAccount(row));
  } catch (e) {
    console.warn(`[accounts] token revoke failed for ${row.platform}:`, e instanceof Error ? e.message : e);
  }

  await db.delete(socialAccounts).where(eq(socialAccounts.id, id));
  return Response.json({ ok: true });
});
