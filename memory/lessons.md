# Lessons

Format: `YYYY-MM-DD | symptom | cause | fix | evidence`. Newest first.

2026-10-28 | /dashboard/posts reloaded endlessly in `next dev` | dev server started while files were being stashed/restored nearby; HMR kept recompiling (not an app bug: 2 navigations/15s on a fresh server, with and without the change) | restart the dev server after git stash/checkout; measure reloads with Playwright `framenavigated` before blaming code | session
2026-10-28 | Collaborator invite never arrived (post published, invitee public) | unknown: we did not read back what Instagram recorded | the post drawer now asks GET /<media>/collaborators and shows each invite's status | lib/posts.ts postCollaborators

2026-10-28 | Uncommitted schema changes vanished during a mutation test | `git checkout <file>` restores the last COMMIT, not the pre-mutation copy | back up with cp and restore from the copy; commit before mutation-testing | session, lib/db/schema.ts
2026-10-28 | DM sync fallback read messages for idle threads | the `since` filter ran after the per-thread reads | filter threads by updated_time before reading their messages | tests/instagram-adapter.test.ts "falls back to each thread's messages edge"

2026-10-27 | Inbox tabs on phones overlapped the filter below | shadcn TabsList sets `group-data-horizontal/tabs:h-8`, which a plain `h-auto` does not override | add `group-data-horizontal/tabs:h-auto` when tabs wrap (inbox, all posts) | components/inbox/inbox-view.tsx, scratchpad ui-verify/tabs-mobile.cjs
2026-10-27 | Playwright "Reply" button matched two elements | role names match substrings ("No reply needed") | `exact: true` for short button names | ui-verify/live.cjs
2026-10-27 | Mutation test of the "can't refresh" gate in needsRefresh survived | branch was dead: LinkedIn has no custom refresh window, so the default 5-minute path already behaved the same | removed the branch; keep mutation-testing new policy code | lib/accounts.ts needsRefresh, tests/token-refresh.test.ts
2026-10-27 | Inbox would show no title for Instagram posts | `caption` is readable only with Facebook Login, not Instagram Login | title comments with our own post text when the post came from Social Copilot | lib/comments.ts upsertComments, lib/platforms/instagram.ts header
2026-10-27 | Old validation test "LinkedIn is not available yet" failed | LinkedIn became implemented | use a still-unbuilt platform (tiktok) for "coming soon" tests | tests/validation.test.ts
2026-10-27 | User opened localhost in their own browser: ERR_CONNECTION_REFUSED | the app ran in the cloud container, not on their machine | say where the app runs; ship a zip + `npm run demo` and local run steps (Windows PowerShell) | session, scripts/demo.mjs
2026-10-27 | `npm run demo` failed on a clean checkout: ERR_PACKAGE_PATH_NOT_EXPORTED for drizzle-kit/bin.cjs | package `exports` hide the bin file | resolve CLIs by direct node_modules path; always test scripts from a clean checkout | commit 9eff64e
2026-10-27 | `pkill -f "next dev"` (and later `[d]emo.mjs`) killed my own shell, exit 144 | the pattern matched the running bash command line | bracket patterns (`[n]ext-server`) and run kills in a separate command with nothing else on the line | session log
2026-10-27 | Timezone picker did not offer Asia/Kolkata | Chromium reports/lists legacy IANA names (Asia/Calcutta) | normalizeTimeZone + timeZoneOptions; settings API normalizes before saving | lib/time.ts, commit ffb852b
2026-10-27 | Week title garbled | Intl cannot format day+year without month | compose the title manually | lib/calendar.ts titleFor
2026-10-27 | Dashboard "Recent" listed future posts | one query mixed past and upcoming | split recent vs upcoming | lib/analytics.ts
2026-10-27 | Playwright drag test flaky | dnd-kit autoscroll at a 900px viewport, then the Sheet exit animation still blocking clicks | tall viewport; wait for the drawer to be hidden; 3 clean runs before trusting a fix | scratchpad ui-verify/run.cjs
2026-10-27 | UI test counts wrong after switching tabs/search | SWR keepPreviousData showed the old page | wait for the network response, not the DOM | ui-verify/run.cjs
2026-10-27 | Mobile check matched hidden sidebar text | `.first()` picked an invisible element | role-based selectors (headings, buttons) | ui-verify/run.cjs
2026-10-27 | Scheduling test "failed" | test hard-coded a 2030 date; the app correctly rejects > 1 year ahead | relative dates in tests | tests/posts.test.ts
2026-10-27 | svix `verify()` typed as returning undefined | library typing | call verify(), then JSON.parse the raw body | app/api/webhooks/clerk/route.ts
2026-10-27 | npm install peer conflict (vitest 5 vs @types/node 20) | outdated types | @types/node ^22 | package.json
2026-10-27 | Lint errors in generated shadcn files (set-state-in-effect) | generated code, not ours | eslint override for components/ui/** and hooks/** | eslint.config.mjs

## Seeded from the build spec (section 13, known pitfalls)
spec | Connect X: "something went wrong" / 307 | callback path differs from the provider console | exactly `/api/oauth/<platform>/callback` in code and console | spec §13
spec | "Token exchange failed" | schema not pushed, or wrong PKCE verifier/secret | `npm run db:push`; check PKCE and client auth method | spec §13
spec | Real account saved as "mock account" | placeholder logic | always fetch the real profile and store it | spec §13
spec | drizzle-kit: connection URL required | it reads `.env`, not `.env.local` | load dotenv with explicit paths in drizzle.config.ts | spec §13
spec | next/image crash on avatars/media | host not in remotePatterns | add the host to next.config.ts | spec §13
spec | Clerk sign-in blank on a tunnel URL | Next blocks cross-origin dev | allowedDevOrigins (derived from NEXT_PUBLIC_APP_URL), restart | spec §13
spec | Gemini errors | deprecated model id | read GEMINI_MODEL from env | spec §13
spec | ImageKit upload fails silently | missing keys / auth endpoint | check the 3 keys and server logs | spec §13
spec | Inngest app "not synced" locally | missing flag | INNGEST_DEV=1 and the dev server running | spec §13
spec | "Post now" does nothing | UI path does not emit the event | one function for now and schedule | spec §13
spec | Plan shows Free after paying | slug mismatch (pro vs premium) or events not subscribed | one slug: free/premium; subscribe to subscription events | spec §13
spec | Insert fails: invalid UUID | Clerk id in a uuid column | clerk_id text, internal uuid | spec §13
spec | Replies fire repeatedly | no dedupe | unique (account, comment); idempotency key per reply | spec §13
spec | YouTube quota exhausted | polling too often | channel-wide commentThreads (1 unit), 15-minute cron, per-account cooldown | spec §13
spec | Free ngrok limit | one tunnel per account | one tunnel; update every console when the URL changes | spec §13
