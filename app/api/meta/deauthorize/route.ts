import { requireEnv } from "@/lib/env";
import { errorResponse } from "@/lib/errors";
import { parseSignedRequest, revokeInstagramUser } from "@/lib/meta";

export const runtime = "nodejs";

/** Meta "Deauthorize callback URL": called when someone removes the app from their Instagram settings. */
export async function POST(req: Request) {
  try {
    const { INSTAGRAM_APP_SECRET } = requireEnv("INSTAGRAM_APP_SECRET");
    const signed = new URLSearchParams(await req.text()).get("signed_request") ?? "";
    const data = parseSignedRequest(signed, INSTAGRAM_APP_SECRET);
    if (!data) return Response.json({ error: { code: "BAD_SIGNATURE", message: "Invalid signed_request." } }, { status: 400 });
    await revokeInstagramUser(data.user_id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
