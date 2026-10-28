import { randomBytes } from "node:crypto";
import { appUrl, requireEnv } from "@/lib/env";
import { errorResponse } from "@/lib/errors";
import { deleteInstagramUser, parseSignedRequest } from "@/lib/meta";

export const runtime = "nodejs";

/**
 * Meta "Data deletion request URL". Deletion happens immediately; Meta shows the person the status
 * URL and confirmation code we return (the format Meta requires).
 */
export async function POST(req: Request) {
  try {
    const { INSTAGRAM_APP_SECRET } = requireEnv("INSTAGRAM_APP_SECRET");
    const signed = new URLSearchParams(await req.text()).get("signed_request") ?? "";
    const data = parseSignedRequest(signed, INSTAGRAM_APP_SECRET);
    if (!data) return Response.json({ error: { code: "BAD_SIGNATURE", message: "Invalid signed_request." } }, { status: 400 });
    await deleteInstagramUser(data.user_id);
    const code = randomBytes(8).toString("hex");
    return Response.json({ url: `${appUrl()}/data-deletion?code=${code}`, confirmation_code: code });
  } catch (e) {
    return errorResponse(e);
  }
}
