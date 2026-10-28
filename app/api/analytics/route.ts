import { z } from "zod";
import { handle, parseQuery } from "@/lib/api";
import { getAnalytics, RANGES } from "@/lib/analytics";
import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";

const querySchema = z.object({
  range: z.coerce
    .number()
    .refine((n): n is (typeof RANGES)[number] => (RANGES as readonly number[]).includes(n), "range must be 7, 30 or 90")
    .default(30),
});

export const GET = handle(async (req) => {
  const { user } = await requireUser();
  const { range } = parseQuery(req, querySchema);
  return Response.json(await getAnalytics(user.id, user.timezone, range));
});
