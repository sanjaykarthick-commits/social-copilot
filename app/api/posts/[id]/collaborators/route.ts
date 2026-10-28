import { z } from "zod";
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { postCollaborators } from "@/lib/posts";

export const runtime = "nodejs";

/** Collaborator invites on a published post, as the platform reports them right now. */
export const GET = handle<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const parsed = z.uuid().safeParse((await ctx.params).id);
  if (!parsed.success) throw notFound("Post");
  const { user } = await requireUser();
  return Response.json({ targets: await postCollaborators(user.id, parsed.data) });
});
