# Social Copilot

Plan your posts for **Instagram, YouTube and LinkedIn** (and X) on one calendar. Social Copilot publishes them at the right
time, shows how each one did, and brings every comment into one inbox where you can reply.

| Area | Status |
|---|---|
| Sign up / sign in (Clerk) | built |
| Accounts: Instagram (Instagram Login, Business/Creator accounts), YouTube (Google OAuth), LinkedIn (OpenID + Share on LinkedIn), X; reconnect, disconnect, automatic token renewal, expiry warnings | built |
| Composer: several accounts at once, live per-platform rules (Instagram needs media and 4:5–1.91:1 photos, X weighted length, YouTube video + title), previews per platform, media upload, per-account text, drafts | built |
| Publishing: Instagram photo / carousel (up to 10) / Reel; YouTube video; LinkedIn text / photos / video; X text / photos / video. Resumable: a retry never re-uploads or double-posts | built |
| Scheduling: schedule / post now / retry failed platforms / reschedule / edit / delete (Inngest) | built, verified end to end |
| Calendar: month / week / day, drag to reschedule | built |
| Dashboard: totals, activity chart, platform split, up next / recent, engagement per platform, top posts, needs-reply, reconnect warnings | built |
| Comment inbox: Instagram + YouTube comments (and LinkedIn once LinkedIn approves your app), reply, archive, sync every 15 min + Sync now | built |
| Go-live: privacy and terms pages, Meta deauthorize + data-deletion callbacks, `/api/health`, `npm run doctor` | built |
| AI captions / AI replies / auto-reply rules, billing UI, email notifications | not built (deferred on purpose) |

**Not verified (no credentials available here):** the live Instagram, YouTube, LinkedIn, X, Clerk, ImageKit and Neon services,
Inngest Cloud and a Vercel deployment. Request formats follow each platform's current docs and are tested against
protocol-level fakes. See `SETUP_CHECKLIST.md` section 11 for what to test first.

## Go live
**`SETUP_CHECKLIST.md` is the runbook**: Vercel, Neon, Clerk, ImageKit, Inngest, then the Meta, Google and LinkedIn
consoles, in order, with the exact URLs. `npm run doctor` checks your settings and prints those URLs for your domain.

What needs a platform's approval before *other people* can connect: Instagram (Meta App Review + Business Verification),
YouTube (Google OAuth verification; up to 100 users before that), LinkedIn post stats and comments (Community Management
API). Publishing to LinkedIn and everything for **your own** accounts works without waiting.

## See it running in 2 minutes (no accounts, no keys)

```bash
docker compose up -d db     # a local Postgres (or point DATABASE_URL at a LOCAL one you control)
npm install
npm run demo                # then open http://localhost:3000
```

This resets the demo database, loads a demo account (Instagram, YouTube, LinkedIn) with sample posts, stats and comments,
and starts the app and the scheduler. Sign-in is replaced by a built-in demo user (only in this mode; production builds
never include it). The connections are fake, so "Post now", "Sync now" and replies end with the platform's real
"invalid token" error. Scheduling, the calendar, the inbox, filters and analytics all work. Stop with Ctrl+C.

## Develop with real keys

Requirements: Node 22, Postgres (or Neon).

```bash
npm install
cp .env.example .env.local        # fill it in; see SETUP_CHECKLIST.md
npm run db:push                   # create / update tables (after every update)
npm run dev                       # http://localhost:3000
npm run inngest:dev               # second terminal: the local scheduler (http://localhost:8288)
npm run doctor                    # what is missing + the callback URLs to register
npm run plan:set -- you@example.com premium   # billing is not built yet
```

### Environment

| Variable | Needed for |
|---|---|
| `NEXT_PUBLIC_APP_URL` | OAuth redirect URIs, absolute URLs (your https domain; an ngrok URL when testing OAuth locally) |
| `NEXT_PUBLIC_CONTACT_EMAIL` | privacy / terms pages |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET` | sign-in, user sync |
| `DATABASE_URL` | everything |
| `TOKEN_ENCRYPTION_KEY` | storing OAuth tokens (`openssl rand -base64 32`) |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | Instagram (Meta > Instagram > API setup with Instagram login) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | YouTube |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` (+ optional `LINKEDIN_EXTRA_SCOPES`, `LINKEDIN_API_VERSION`) | LinkedIn |
| `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET` | X (optional) |
| `NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY`, `IMAGEKIT_PRIVATE_KEY`, `NEXT_PUBLIC_IMAGEKIT_URL_ENDPOINT` | media upload |
| `INNGEST_DEV=1` (local) / `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` (prod) | scheduling, comment sync, token renewal |

## How scheduling works

```
Composer ─POST /api/posts─▶ lib/posts.ts ──(1) stamp new token in DB
                                          └(2) send Inngest event ── fails? revert, keep as draft
                                           (3) cancel the old run (reschedule/edit)
Inngest `publish-post`: [sleep until the time] ─▶ re-check token + status in the DB ─▶ one step per platform
                         ─▶ publish ─▶ finalize (published only if every platform succeeded)
```

- The database is the source of truth. A run that wakes with a stale token (rescheduled, edited, deleted, or a lost cancel)
  does nothing, so a post can never be published twice or at an old time.
- Each platform is its own step: a rate limit or failure on one never repeats or blocks another. Transient errors
  (429, 5xx, network, "still processing") retry with backoff; permanent ones (bad media, expired token) fail with the platform's message.
- Slow uploads save progress (`post_targets.publish_state`): an Instagram container or LinkedIn upload is reused on retry,
  and a post Instagram already published is never published again.
- A post that is partly published shows **Failed** with a per-platform reason; **Retry** re-runs only what failed.

Other scheduled jobs: `sync-comments` (every 15 min), `sync-post-metrics` (every 6 h), `refresh-tokens` (daily; Instagram
tokens are renewed 20 days before they expire, LinkedIn connections get a reconnect warning).

## Testing

```bash
DATABASE_URL=postgresql://sc:sc@localhost:5432/social_copilot npm test   # 279 tests; DB-backed ones need a local Postgres
npm run e2e:scheduler    # boots the REAL Inngest dev server + Postgres; only api.x.com is faked (local DB only)
```

Covered: every adapter's protocol against stateful fakes (Instagram container flow, carousel, Reels, resume, never
double-publish; LinkedIn image/video upload parts and ETags, little-text escaping, approval-gated stats and comments;
YouTube resumable upload, channel-wide comments, replies; X chunked upload), each mutation-checked; the comment inbox
(sync never reopens handled comments, idempotent replies, failures recorded); token renewal policy; Meta signed requests;
the post service and publisher; analytics; calendar/timezone math; the scheduler end to end.

UI was verified in a real browser (`E2E_FAKE_AUTH=1`, see `tests/e2e/fake-clerk/README.md`): dashboard, inbox (reply,
archive, sync, failure display), accounts, composer previews, legal pages, dark mode and a 390px phone viewport.

## Layout

```
app/                 routes (dashboard/*, api/*, privacy, terms, data-deletion, sign-in, sign-up)
components/          ui/ (shadcn on Base UI), compose/, calendar/, posts/, dashboard/, inbox/, accounts/, legal/, layout/
lib/platforms/       one adapter per platform (instagram, youtube, linkedin, twitter) + meta (client-safe)
lib/posts.ts         every post state transition
lib/publisher.ts     publishing core (Inngest-independent, unit-tested)
lib/comments.ts      inbox sync, list, reply, archive
lib/inngest/         client, events, functions
lib/validation/      rules shared by the browser and the API
memory/              lessons, decisions and preferences for future work (see memory-and-dreaming-context.md)
scripts/             demo, seed, doctor, set-plan, e2e scheduler
```

See `CLAUDE.md` for conventions and how to add a platform, and `DESIGN.md` for the UI guide.

## Known limitations
- Instagram: Business or Creator accounts only; no Stories; captions of posts not made with Social Copilot cannot be read
  (Instagram Login does not expose them), so the inbox shows "Instagram post" for those.
- LinkedIn: personal profiles only (company pages need LinkedIn's Community Management API); no stats or comment reading
  without that approval; connections must be renewed by the user every 60 days.
- YouTube: video only (the API has no community posts); the default quota allows about 6 uploads a day per project.
- Billing is not built: plans are set with `npm run plan:set`. Deleting a post removes it from Social Copilot only.
