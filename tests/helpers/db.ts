import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";

/** DB-backed tests need a real Postgres. Skipped (not faked) when DATABASE_URL is unset. */
export const hasDb = Boolean(process.env.DATABASE_URL);

export async function resetDb() {
  const db = getDb();
  // CASCADE from users clears every dependent table.
  await db.execute(sql`TRUNCATE TABLE users RESTART IDENTITY CASCADE`);
}
