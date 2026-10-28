import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // DB-backed tests share one Postgres; run files serially to keep them deterministic.
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      // Test-only key (32 bytes of 0x07). Never used outside vitest.
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      // Fake OAuth app credentials so adapters can build requests; fetch is always stubbed in tests.
      TWITTER_CLIENT_ID: "test-x-id",
      TWITTER_CLIENT_SECRET: "test-x-secret",
      GOOGLE_CLIENT_ID: "test-g-id",
      GOOGLE_CLIENT_SECRET: "test-g-secret",
      INSTAGRAM_APP_ID: "test-ig-id",
      INSTAGRAM_APP_SECRET: "test-ig-secret",
      LINKEDIN_CLIENT_ID: "test-li-id",
      LINKEDIN_CLIENT_SECRET: "test-li-secret",
    },
  },
});
