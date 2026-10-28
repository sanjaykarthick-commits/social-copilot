import { handle, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { replyToConversation } from "@/lib/messages";
import { messageReplyBodySchema } from "@/lib/validation/messages";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Reply in a conversation (only within 24 hours of the person's last message). */
export const POST = handle<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { user } = await requireUser();
  const { id } = await ctx.params;
  const body = await parseBody(req, messageReplyBodySchema);
  return Response.json(await replyToConversation(user.id, id, body));
});
