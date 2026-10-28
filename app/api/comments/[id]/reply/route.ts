import { handle, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { replyToComment } from "@/lib/comments";
import { replyBodySchema } from "@/lib/validation/comments";

export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = handle<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { user } = await requireUser();
  const { id } = await ctx.params;
  const body = await parseBody(req, replyBodySchema);
  return Response.json({ comment: await replyToComment(user.id, id, body) });
});
