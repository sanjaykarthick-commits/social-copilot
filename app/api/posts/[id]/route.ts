import { z } from "zod";
import { handle, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { deletePost, replacePost, reschedulePost } from "@/lib/posts";
import { getPostDTO } from "@/lib/posts-query";
import { postBodySchema, rescheduleSchema } from "@/lib/validation/posts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };
const idSchema = z.uuid();

async function ctxId(ctx: Ctx) {
  const parsed = idSchema.safeParse((await ctx.params).id);
  if (!parsed.success) throw notFound("Post");
  return parsed.data;
}

export const GET = handle<Ctx>(async (_req, ctx) => {
  const id = await ctxId(ctx);
  const { user } = await requireUser();
  const post = await getPostDTO(user.id, id);
  if (!post) throw notFound("Post");
  return Response.json({ post });
});

/** Full edit (what the composer sends). */
export const PUT = handle<Ctx>(async (req, ctx) => {
  const id = await ctxId(ctx);
  const { user, plan } = await requireUser();
  const body = await parseBody(req, postBodySchema);
  return Response.json({ post: await replacePost({ userId: user.id, plan }, id, body) });
});

/** Move a scheduled post to a new time (calendar drag and drop). */
export const PATCH = handle<Ctx>(async (req, ctx) => {
  const id = await ctxId(ctx);
  const { user, plan } = await requireUser();
  const { scheduledAt } = await parseBody(req, rescheduleSchema);
  return Response.json({ post: await reschedulePost({ userId: user.id, plan }, id, new Date(scheduledAt)) });
});

/** `?fromPlatforms=1` also deletes the published copies on platforms that allow it (Instagram). */
export const DELETE = handle<Ctx>(async (req, ctx) => {
  const id = await ctxId(ctx);
  const { user, plan } = await requireUser();
  await deletePost({ userId: user.id, plan }, id, { fromPlatforms: new URL(req.url).searchParams.get("fromPlatforms") === "1" });
  return Response.json({ ok: true });
});
