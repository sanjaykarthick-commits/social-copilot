import { randomUUID } from "node:crypto";
import { inngest } from "@/lib/inngest/client";
import { AppError } from "@/lib/errors";

/** Event contract between the API routes and the Inngest functions. */
export const EVENTS = {
  scheduled: "post/scheduled",
  publishNow: "post/publish.now",
  cancelled: "post/cancelled",
} as const;

export interface PostEventData {
  postId: string;
  /**
   * Unique per scheduling action and stored on posts.inngest_event_id. The run
   * re-checks it when it wakes, so a stale run (an old time, a cancelled post)
   * can never publish, even if the cancel event is delayed or lost.
   */
  token: string;
  /** ISO time to publish at ("post/scheduled" only). */
  scheduledAt?: string;
}

export const newScheduleToken = () => randomUUID();

async function send(payload: { name: string; id?: string; data: PostEventData }) {
  try {
    await inngest.send(payload);
  } catch (e) {
    console.error("[inngest] send failed", e);
    throw new AppError(
      "SCHEDULER_UNAVAILABLE",
      "The scheduler is not reachable right now, so nothing was queued. Check that Inngest is running and configured (see SETUP_CHECKLIST.md), then try again.",
      503,
    );
  }
}

export const sendScheduled = (data: Required<PostEventData>) => send({ name: EVENTS.scheduled, id: `sched-${data.token}`, data });
export const sendPublishNow = (data: Pick<PostEventData, "postId" | "token">) => send({ name: EVENTS.publishNow, id: `now-${data.token}`, data });
/** Cancels the run created for `token` (and only that one). */
export const sendCancel = (data: Pick<PostEventData, "postId" | "token">) => send({ name: EVENTS.cancelled, data });
