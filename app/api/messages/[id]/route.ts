import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getThread } from "@/lib/messages";

export const runtime = "nodejs";

/** One conversation with its latest messages. */
export const GET = handle<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const { user } = await requireUser();
  const { id } = await ctx.params;
  return Response.json(await getThread(user.id, id));
});
