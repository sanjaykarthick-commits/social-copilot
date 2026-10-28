import { handle, parseBody, parseQuery } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { createPost } from "@/lib/posts";
import { listPosts } from "@/lib/posts-query";
import { postBodySchema, postListQuerySchema } from "@/lib/validation/posts";

export const runtime = "nodejs";

export const GET = handle(async (req) => {
  const { user } = await requireUser();
  const q = parseQuery(req, postListQuerySchema);
  const { posts, total } = await listPosts(user.id, q);
  return Response.json({ posts, total, page: q.page, pageSize: q.pageSize });
});

export const POST = handle(async (req) => {
  const { user, plan } = await requireUser();
  const body = await parseBody(req, postBodySchema);
  const post = await createPost({ userId: user.id, plan }, body);
  return Response.json({ post }, { status: 201 });
});
