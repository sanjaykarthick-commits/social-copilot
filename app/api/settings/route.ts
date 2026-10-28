import { eq } from "drizzle-orm";
import { z } from "zod";
import { handle, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { isValidTimeZone, normalizeTimeZone } from "@/lib/time";

export const runtime = "nodejs";

const patchSchema = z.object({
  timezone: z.string().max(64).refine(isValidTimeZone, "Unknown timezone").optional(),
});

export const GET = handle(async () => {
  const { user, plan } = await requireUser();
  return Response.json({ timezone: user.timezone, plan, email: user.email, name: user.name });
});

export const PATCH = handle(async (req) => {
  const { user } = await requireUser();
  const body = await parseBody(req, patchSchema);
  const timezone = body.timezone ? normalizeTimeZone(body.timezone) : undefined;
  if (timezone) await getDb().update(users).set({ timezone, updatedAt: new Date() }).where(eq(users.id, user.id));
  return Response.json({ ok: true, timezone: timezone ?? user.timezone });
});
