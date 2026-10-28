import { Webhook } from "svix";
import type { WebhookEvent } from "@clerk/nextjs/webhooks";
import { requireEnv } from "@/lib/env";
import { errorResponse } from "@/lib/errors";
import { handleClerkEvent } from "@/lib/clerk-events";

export const runtime = "nodejs";

/**
 * Clerk -> us. Verified with svix (svix-id / svix-timestamp / svix-signature) and
 * CLERK_WEBHOOK_SECRET. Public route (see proxy.ts). Returns 200 quickly; a 500
 * makes Clerk retry, and the full error is logged for the Clerk webhook log.
 */
export async function POST(req: Request) {
  let secret: string;
  try {
    secret = requireEnv("CLERK_WEBHOOK_SECRET").CLERK_WEBHOOK_SECRET;
  } catch (e) {
    return errorResponse(e);
  }

  const id = req.headers.get("svix-id");
  const timestamp = req.headers.get("svix-timestamp");
  const signature = req.headers.get("svix-signature");
  if (!id || !timestamp || !signature) {
    return Response.json({ error: { code: "BAD_REQUEST", message: "Missing svix headers." } }, { status: 400 });
  }

  const body = await req.text();
  try {
    // verify() throws on a bad signature or a stale timestamp. Its return type is
    // unreliable across svix versions, so we parse the (now trusted) body ourselves.
    new Webhook(secret).verify(body, {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
    });
  } catch (e) {
    console.warn("[clerk-webhook] signature verification failed", e instanceof Error ? e.message : e);
    return Response.json({ error: { code: "BAD_SIGNATURE", message: "Invalid webhook signature." } }, { status: 400 });
  }

  const evt = JSON.parse(body) as WebhookEvent & { timestamp?: number };
  try {
    const outcome = await handleClerkEvent(evt, evt.timestamp);
    console.log(`[clerk-webhook] ${id} ${outcome}`);
    return Response.json({ ok: true, outcome });
  } catch (e) {
    console.error(`[clerk-webhook] ${id} ${evt.type} failed`, e);
    return Response.json({ error: { code: "HANDLER_FAILED", message: "Webhook handler failed." } }, { status: 500 });
  }
}
