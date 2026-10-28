import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { getUsableAccount } from "@/lib/accounts";
import type { Platform } from "@/lib/constants";
import { getDb } from "@/lib/db";
import { postMetrics, postTargets } from "@/lib/db/schema";
import { getAdapter } from "@/lib/platforms";
import { PlatformError, type PostMetrics } from "@/lib/platforms/types";

export interface MetricsSyncResult {
  accounts: number;
  updated: number;
  /** Accounts we could not read, with the reason (e.g. the X plan has no read access). */
  skipped: { accountId: string; reason: string }[];
}

export async function upsertMetrics(targetId: string, m: PostMetrics, now = new Date()) {
  // Nothing reported means nothing to store: a row of nulls would read as zeros on the dashboard.
  if (m.likes === null && m.comments === null && m.impressions === null) return false;
  await getDb()
    .insert(postMetrics)
    .values({ postTargetId: targetId, likes: m.likes, comments: m.comments, impressions: m.impressions, fetchedAt: now })
    .onConflictDoUpdate({
      target: postMetrics.postTargetId,
      set: { likes: m.likes, comments: m.comments, impressions: m.impressions, fetchedAt: now },
    });
  return true;
}

/**
 * Pull engagement for posts published in the last `sinceDays`, one request batch per account.
 * One account failing (no read access on its X plan, a revoked token, quota) never stops the others,
 * and a failure never writes a made-up zero: the old numbers stay and the reason is reported.
 */
export async function syncMetrics(opts: { now?: Date; sinceDays?: number } = {}): Promise<MetricsSyncResult> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.sinceDays ?? 30) * 86_400_000);
  const db = getDb();

  const rows = await db
    .select({ id: postTargets.id, platformPostId: postTargets.platformPostId, accountId: postTargets.socialAccountId, platform: postTargets.platform })
    .from(postTargets)
    .where(and(eq(postTargets.status, "published"), isNotNull(postTargets.platformPostId), gte(postTargets.publishedAt, since), sql`${postTargets.platformPostId} is not null`));

  const byAccount = new Map<string, typeof rows>();
  for (const r of rows) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r]);

  const result: MetricsSyncResult = { accounts: byAccount.size, updated: 0, skipped: [] };
  for (const [accountId, targets] of byAccount) {
    const adapter = getAdapter(targets[0].platform as Platform);
    if (!adapter.fetchMetrics) {
      result.skipped.push({ accountId, reason: "platform has no metrics support" });
      continue;
    }
    try {
      const account = await getUsableAccount(accountId);
      const found = await adapter.fetchMetrics(account, targets.map((t) => t.platformPostId!));
      for (const t of targets) {
        const m = found.get(t.platformPostId!);
        if (m && (await upsertMetrics(t.id, m, now))) result.updated += 1;
      }
    } catch (e) {
      result.skipped.push({ accountId, reason: e instanceof PlatformError ? e.message : e instanceof Error ? e.message : "unknown error" });
    }
  }
  return result;
}
