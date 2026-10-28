import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { isConfigured } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Uptime check. Says only whether the app and its database answer; configuration details stay private (npm run doctor). */
export async function GET() {
  let db = false;
  if (isConfigured("DATABASE_URL")) {
    try {
      await getDb().execute(sql`select 1`);
      db = true;
    } catch {
      db = false;
    }
  }
  return Response.json({ ok: db, db }, { status: db ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
