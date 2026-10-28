import { handle, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { setCommentStatus } from "@/lib/comments";
import { commentPatchSchema } from "@/lib/validation/comments";

export const runtime = "nodejs";

/** Archive a comment (no reply needed) or move it back to the inbox. */
export const PATCH = handle<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { user } = await requireUser();
  const { id } = await ctx.params;
  const { status } = await parseBody(req, commentPatchSchema);
  return Response.json({ comment: await setCommentStatus(user.id, id, status) });
});
