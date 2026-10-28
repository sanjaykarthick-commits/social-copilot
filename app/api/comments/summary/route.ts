import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { countOpenComments } from "@/lib/comments";

export const runtime = "nodejs";

/** The "needs reply" badge in the sidebar. */
export const GET = handle(async () => {
  const { user } = await requireUser();
  return Response.json({ open: await countOpenComments(user.id) });
});
