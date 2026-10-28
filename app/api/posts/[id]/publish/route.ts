import { z } from "zod";
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { publishPostNow } from "@/lib/posts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** "Publish now" for a draft/scheduled post, and "Retry" for a failed one. Same publish path as scheduling. */
export const POST = handle<Ctx>(async (_req, ctx) => {
  const parsed = z.uuid().safeParse((await ctx.params).id);
  if (!parsed.success) throw notFound("Post");
  const { user, plan } = await requireUser();
  return Response.json({ post: await publishPostNow({ userId: user.id, plan }, parsed.data) });
});
