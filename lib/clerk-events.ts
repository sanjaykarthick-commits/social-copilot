import type { WebhookEvent } from "@clerk/nextjs/webhooks";
import { resolveFromItem, resolveFromSubscription } from "@/lib/billing";
import { applyPlanAction, deleteUserByClerkId, profileFromClerkJson, upsertUser } from "@/lib/users";

/**
 * Applies a verified Clerk webhook event to our database.
 * Idempotent (Clerk retries) and tolerant of unknown event types.
 * Returns a short human-readable outcome for logs.
 */
export async function handleClerkEvent(evt: WebhookEvent, eventTimestamp?: number): Promise<string> {
  const eventAt = eventTimestamp ? new Date(eventTimestamp) : null;

  switch (evt.type) {
    case "user.created":
    case "user.updated": {
      const user = await upsertUser(evt.data.id, profileFromClerkJson(evt.data));
      return `${evt.type}: upserted ${user.id}`;
    }

    case "user.deleted": {
      if (!evt.data.id) return "user.deleted: no id";
      const removed = await deleteUserByClerkId(evt.data.id);
      return `user.deleted: ${removed ? "removed" : "not found"}`;
    }

    case "subscription.created":
    case "subscription.updated":
    case "subscription.active":
    case "subscription.pastDue": {
      const clerkId = evt.data.payer?.user_id;
      if (!clerkId) return `${evt.type}: no user payer (organization billing is not supported)`;
      const result = await applyPlanAction(clerkId, resolveFromSubscription({ id: evt.data.id, items: evt.data.items }), {
        eventAt,
        profile: { email: evt.data.payer.email, imageUrl: evt.data.payer.image_url },
      });
      return `${evt.type}: ${result}`;
    }

    case "subscriptionItem.created":
    case "subscriptionItem.updated":
    case "subscriptionItem.active":
    case "subscriptionItem.canceled":
    case "subscriptionItem.upcoming":
    case "subscriptionItem.ended":
    case "subscriptionItem.abandoned":
    case "subscriptionItem.incomplete":
    case "subscriptionItem.pastDue":
    case "subscriptionItem.freeTrialEnding": {
      const clerkId = evt.data.payer?.user_id;
      if (!clerkId) return `${evt.type}: no user payer`;
      const result = await applyPlanAction(clerkId, resolveFromItem(evt.data), {
        eventAt,
        profile: { email: evt.data.payer?.email, imageUrl: evt.data.payer?.image_url },
      });
      return `${evt.type}: ${result}`;
    }

    default:
      return `${evt.type}: ignored`;
  }
}
