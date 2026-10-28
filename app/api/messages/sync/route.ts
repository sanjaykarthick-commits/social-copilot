import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { syncMessages } from "@/lib/messages";

export const runtime = "nodejs";
export const maxDuration = 120;

/** "Sync now" and opening the Messages tab. Each account is synced at most once a minute. */
export const POST = handle(async () => {
  const { user } = await requireUser();
  const { added, failed, results } = await syncMessages({ userId: user.id, respectCooldown: true });
  return Response.json({
    added,
    synced: results.length,
    notes: results.filter((r) => r.skipped).map((r) => ({ accountId: r.accountId, reason: r.skipped })),
    failed,
  });
});
