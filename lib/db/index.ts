import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { requireEnv } from "@/lib/env";
import * as schema from "@/lib/db/schema";

export type Db = NodePgDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { __pool?: Pool; __db?: Db };

/**
 * node-postgres works with a Neon *pooled* connection string and with a plain
 * local Postgres, so the same code is verified locally and runs on Vercel.
 * The pool is a process singleton (also survives dev hot reloads).
 */
export function getDb(): Db {
  if (globalForDb.__db) return globalForDb.__db;
  const { DATABASE_URL } = requireEnv("DATABASE_URL");
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", (e) => console.error("[db] idle client error", e));
  globalForDb.__pool = pool;
  globalForDb.__db = drizzle(pool, { schema });
  return globalForDb.__db;
}

export { schema };
