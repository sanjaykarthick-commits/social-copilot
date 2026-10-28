# Fake Clerk (test harness only)

Stands in for `@clerk/nextjs` so the real app can be driven in a browser (Playwright,
screenshots) without Clerk credentials. Everything else is real: Next.js, the API routes,
Postgres and the Inngest dev server.

It is only wired in when **both** are true (see `next.config.ts`):

- `E2E_FAKE_AUTH=1`
- `NODE_ENV !== "production"`

so it can never be bundled into a production build. The signed-in user is `E2E_FAKE_USER_ID`
(default `user_e2e`).
