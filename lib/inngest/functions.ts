import { refreshExpiringAccounts } from "@/lib/accounts";
import { syncComments } from "@/lib/comments";
import { syncMessages } from "@/lib/messages";
import { EVENTS, type PostEventData } from "@/lib/inngest/events";
import { inngest } from "@/lib/inngest/client";
import { syncMetrics } from "@/lib/metrics";
import { beginPublish, failPost, finalizePost, publishTarget } from "@/lib/publisher";

const DAY_MS = 86_400_000;
/** Sleep in segments so far-future posts do not depend on the plan's maximum sleep. */
const SLEEP_SEGMENT_MS = 7 * DAY_MS;

/**
 * One function for both "Schedule" and "Post now", so there is a single publish
 * code path. The only difference is that scheduled runs sleep first.
 *
 *  - cancelOn: a "post/cancelled" event for the same post AND token ends the run
 *    (even while it sleeps). Matching the token means cancelling an old schedule
 *    can never cancel the new one created right after a reschedule.
 *  - idempotency: the same schedule token never starts two runs.
 *  - Safety net: when it wakes, beginPublish() re-checks the token and status in
 *    the database; stale runs do nothing.
 */
export const publishPost = inngest.createFunction(
  {
    id: "publish-post",
    triggers: [{ event: EVENTS.scheduled }, { event: EVENTS.publishNow }],
    retries: 4,
    idempotency: "event.data.token",
    cancelOn: [
      {
        event: EVENTS.cancelled,
        if: "async.data.postId == event.data.postId && async.data.token == event.data.token",
      },
    ],
    onFailure: async ({ event, error }) => {
      const original = (event.data as { event?: { data?: PostEventData } }).event?.data;
      if (original?.postId && original.token) {
        await failPost(original.postId, original.token, `Publishing failed after several attempts: ${error.message}`);
      }
    },
  },
  async ({ event, step }) => {
    const { postId, token, scheduledAt } = event.data as PostEventData;

    if (event.name === EVENTS.scheduled && scheduledAt) {
      const target = new Date(scheduledAt).getTime();
      const origin = event.ts ?? Date.now();
      const segments = Math.max(1, Math.ceil((target - origin) / SLEEP_SEGMENT_MS));
      for (let i = 1; i <= segments; i += 1) {
        // Deterministic step ids and wake times: safe across replays.
        await step.sleepUntil(`wait-${i}`, new Date(Math.min(target, origin + i * SLEEP_SEGMENT_MS)));
      }
    }

    const begin = await step.run("begin", () => beginPublish(postId, token));
    if (!begin.proceed) return { skipped: begin.reason };

    // One step per platform: a failure or rate limit on one never blocks, repeats or double-posts another.
    const outcomes: Record<string, string> = {};
    for (const targetId of begin.targetIds) {
      const outcome = await step.run(`publish-${targetId}`, () => publishTarget(targetId));
      outcomes[targetId] = outcome.status;
    }

    const status = await step.run("finalize", () => finalizePost(postId));
    return { status, outcomes };
  },
);

/**
 * Engagement numbers for the analytics page. Every 6 hours is plenty for a dashboard and
 * keeps well inside platform rate limits and quotas.
 */
export const syncPostMetrics = inngest.createFunction(
  { id: "sync-post-metrics", triggers: [{ cron: "0 */6 * * *" }], retries: 1 },
  async ({ step }) => step.run("sync", () => syncMetrics()),
);

/**
 * The comment inbox, every 15 minutes. YouTube reads the whole channel in one call (1 quota unit),
 * so this stays far inside the daily quota; "Sync now" covers the gaps.
 */
export const syncAllComments = inngest.createFunction(
  { id: "sync-comments", triggers: [{ cron: "*/15 * * * *" }], retries: 1, concurrency: { limit: 1 } },
  async ({ step }) => {
    const r = await step.run("sync", () => syncComments());
    return { added: r.added, accounts: r.results.length, failed: r.failed };
  },
);

/**
 * Instagram DMs, every 15 minutes (offset from the comment sync). Polling, not webhooks, in v1; the
 * Messages tab also syncs when it opens.
 */
export const syncAllMessages = inngest.createFunction(
  { id: "sync-messages", triggers: [{ cron: "7-59/15 * * * *" }], retries: 1, concurrency: { limit: 1 } },
  async ({ step }) => {
    const r = await step.run("sync", () => syncMessages());
    return { added: r.added, accounts: r.results.length, failed: r.failed };
  },
);

/** Renew tokens before they lapse, even for idle accounts (an Instagram token unused for 60 days is gone). */
export const refreshTokens = inngest.createFunction(
  { id: "refresh-tokens", triggers: [{ cron: "17 3 * * *" }], retries: 1 },
  async ({ step }) => step.run("refresh", () => refreshExpiringAccounts()),
);

export const functions = [publishPost, syncPostMetrics, syncAllComments, syncAllMessages, refreshTokens];
