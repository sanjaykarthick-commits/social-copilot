import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// drizzle-kit only reads .env by default; load .env.local explicitly so there is
// a single source of truth (.env.local), with .env as a fallback.
config({ path: ".env.local" });
config({ path: ".env" });

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
