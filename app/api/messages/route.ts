import { handle, parseQuery } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { listConversations } from "@/lib/messages";
import { conversationListQuerySchema } from "@/lib/validation/messages";

export const runtime = "nodejs";

/** Instagram conversations, most recent first. */
export const GET = handle(async (req) => {
  const { user } = await requireUser();
  const q = parseQuery(req, conversationListQuerySchema);
  return Response.json({ ...(await listConversations(user.id, q)), page: q.page, pageSize: q.pageSize });
});
