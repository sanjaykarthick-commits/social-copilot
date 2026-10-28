import { handle, parseQuery } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { listComments } from "@/lib/comments";
import { commentListQuerySchema } from "@/lib/validation/comments";

export const runtime = "nodejs";

export const GET = handle(async (req) => {
  const { user } = await requireUser();
  const q = parseQuery(req, commentListQuerySchema);
  return Response.json({ ...(await listComments(user.id, q)), page: q.page, pageSize: q.pageSize });
});
