# Go-live checklist

Everything here needs a person: an account, a console, or a secret. The code is done. Work top to bottom.
After each step, run **`npm run doctor`**: it checks your settings and prints the exact URLs to paste into each console.

Legend: **[YOU]** = you must do it. `<APP_URL>` = your live https domain, e.g. `https://socialcopilot.yourname.com`
or the `https://<project>.vercel.app` Vercel gives you.

> **Verified vs. not.** Scheduling, the database layer, validation, the calendar, analytics, the comment inbox and the UI
> were verified against a real Postgres, a real Inngest dev server and a real browser. The Instagram, YouTube and LinkedIn
> request formats were checked against their current docs (October 2026) and tested against protocol-level fakes; the
> demo also reached the real Instagram API, which answered "invalid token" as expected. They have **not** been run with
> real credentials, because none are available here. Expect to fix small things the first time you connect each one.
> Section 11 says what to test first.

## What "live" means, and what needs a platform's approval

| | Works for **you** (your own accounts) | Works for **anyone who signs up** |
|---|---|---|
| Sign up, schedule, calendar, dashboard | today | today |
| **Instagram**: publish, stats, comments | today, in Meta's development mode, once your Instagram account is added as a tester | after **Meta App Review** (Advanced Access) + **Business Verification**. Usually days to weeks. |
| **Instagram**: direct messages (Inbox > Messages) | today, in development mode, if your login configuration grants `instagram_manage_messages` | after **Meta App Review: Advanced Access for `instagram_manage_messages`** (plus Business Verification). Until then other people's accounts show "Reconnect and allow message access". |
| **YouTube**: publish, stats, comments | today (add yourself as a test user) | after **Google OAuth verification** for the YouTube scopes. Until then up to 100 users, who see an "unverified app" warning. |
| **LinkedIn**: publish (text, photos, video) | today | today (self-serve products, no review) |
| **LinkedIn**: post stats + reading comments | only if LinkedIn approves your app for the **Community Management API** | same |

## 1. Hosting: Vercel [YOU]
1. Put the project in a GitHub repo (or run `npx vercel` from the project folder; it asks a few questions and deploys).
2. vercel.com > Add New > Project > import the repo. Framework: Next.js. Do not deploy yet; add the variables below first.
3. Settings > Domains: add your domain, or use the `*.vercel.app` one. That https URL is `<APP_URL>`.
4. Set `NEXT_PUBLIC_APP_URL=<APP_URL>` and `NEXT_PUBLIC_CONTACT_EMAIL=<your email>` in Settings > Environment Variables.

## 2. Database: Neon [YOU]
1. neon.tech > New project > database `social_copilot`. Copy the **pooled** connection string to `DATABASE_URL` (Vercel and `.env.local`).
2. On your machine, with `DATABASE_URL` in `.env.local`: `npm run db:push` (creates the tables). Run it again after every update.

## 3. Encryption key [YOU]
`openssl rand -base64 32` (or any 32 random bytes in base64) -> `TOKEN_ENCRYPTION_KEY`. Keep a copy. Changing or losing
it makes every stored connection unreadable, and everyone must reconnect.

## 4. Sign-in: Clerk [YOU]
1. dashboard.clerk.com > Create application (email + Google sign-in is a good default).
2. For the live site create a **Production** instance: Clerk asks for your domain and gives DNS records to add (Vercel > Domains > DNS).
   Copy the `pk_live_...` / `sk_live_...` keys to `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY`.
3. Webhooks > Add endpoint: `<APP_URL>/api/webhooks/clerk`, events `user.*`. Copy the signing secret to `CLERK_WEBHOOK_SECRET`.
4. Paths: sign-in `/sign-in`, sign-up `/sign-up`.

## 5. Media: ImageKit [YOU]
imagekit.io > Developer options: copy the public key, private key and URL endpoint to `NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY`,
`IMAGEKIT_PRIVATE_KEY`, `NEXT_PUBLIC_IMAGEKIT_URL_ENDPOINT`. Instagram fetches your photos from ImageKit and needs JPEG:
the app asks ImageKit to convert on the fly (`tr=f-jpg`), so leave ImageKit's URL transformations enabled.

## 6. Scheduler: Inngest [YOU]
1. Vercel > Integrations > Inngest > Install for this project. It adds `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`.
2. **Do not set `INNGEST_DEV` on Vercel.**
3. If Vercel Deployment Protection is on, add the bypass secret in Inngest's app settings so it can reach `<APP_URL>/api/inngest`.
4. If Inngest shows no app or no functions (posts then stay on "Publishing" forever), sync by hand after the deploy:
`curl -X PUT <APP_URL>/api/inngest` should answer "Successfully registered". After deploying, Inngest shows five functions: `publish-post`, `sync-post-metrics`, `sync-comments` (every 15 min), `sync-messages` (every 15 min), `refresh-tokens` (daily).

## 7. Instagram (Meta) [YOU]
Requirements: an Instagram **Business or Creator** account (Instagram app > Settings > Account type and tools > Switch to
professional account). No Facebook Page is needed.
1. developers.facebook.com > My Apps > Create app. Use case: **Manage messaging & content on Instagram**. App type: Business.
2. **New apps (since late 2026): "API setup with Unified login".** Meta no longer offers Instagram login to new apps; the
   page says so in a grey banner. Then:
   - Copy the **Configuration ID** shown on that page to `INSTAGRAM_CONFIG_ID` (this switches the app to unified login).
   - App settings > Basic: copy the **App ID** and **App secret** to `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET`.
   - On the unified login page, **Register a new redirect URL**: `<APP_URL>/api/oauth/instagram/callback` > Save.
   - Unified login is not in Meta's public docs yet; it was built from the dashboard's generated Login URL. On the first
     connection, Vercel's logs show `[instagram] unified login: ...` lines saying which route found the account.
   - **Known gap (October 2026):** this configuration issues a business integration (SYSTEM_USER) token whose Instagram
     permissions name no account, and it ignores `business_management` added to the configuration, so the app cannot
     discover the account. Stopgap that works: set `INSTAGRAM_ACCOUNT_ID` to the account's id (Business settings >
     Instagram accounts, or this page's "Generate access tokens" list). It works for that one account only; other
     people's accounts need a proper fix (a user access token configuration, or Meta documenting the flow).
     Also on this page: assign the account the **Instagram Tester** role and add it under **Generate access tokens**.
   **Older apps that still have "API setup with Instagram login":** copy the **Instagram app ID** and **Instagram app
   secret** (not the Meta app ID) to `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET`, leave `INSTAGRAM_CONFIG_ID` unset, and:
3. On that page, **Set up Instagram business login > Business login settings**:
   - OAuth redirect URI: `<APP_URL>/api/oauth/instagram/callback`
   - Deauthorize callback URL: `<APP_URL>/api/meta/deauthorize`
   - Data deletion request URL: `<APP_URL>/api/meta/data-deletion`
4. App settings > Basic: Privacy policy URL `<APP_URL>/privacy`, Terms URL `<APP_URL>/terms`, User data deletion: callback
   `<APP_URL>/api/meta/data-deletion`, an app icon, a category.
5. **Use it yourself now:** App roles > Roles > Add people > **Instagram Tester** > your Instagram username. Accept the invite
   in Instagram (on the web: Settings > Apps and websites > Tester invites). Then Accounts > Connect Instagram.
6. **Open it to everyone:** App Review > Permissions and features > request **Advanced Access** for
   `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`,
   `instagram_business_manage_insights`. Meta asks for a screencast of each feature (connect, publish, insights, reply)
   and **Business Verification** of your business. Then switch the app to **Live**.
   **Direct messages** also need **Advanced Access for `instagram_manage_messages`** (with unified login; with Instagram
   login it is `instagram_business_manage_messages`, which the app does not request yet). Screencast: open Inbox >
   Messages, open a conversation, send a reply within 24 hours of the person's message, show it arriving in Instagram.
   Without it, DMs only work for accounts with a role on the app (yours). The app reads messages by polling (every 15
   minutes, and when the Messages tab opens); no messaging webhook is needed for v1.
   Rules Meta enforces and the app follows: replies only within **24 hours** of the person's last message (the reply
   box closes after that), and a business can never start a conversation.
7. Limits to know: Instagram allows about 100 API-published posts per 24 hours per account; photos are sent as JPEG between
   4:5 and 1.91:1 (the composer checks this); a single video is published as a Reel (max 300 MB); carousels hold up to 10 items here.
   Connections last 60 days and are renewed automatically (daily job).

## 8. YouTube (Google) [YOU]
1. console.cloud.google.com > create a project > APIs & Services > Library > enable **YouTube Data API v3**.
2. OAuth consent screen (Google Auth Platform): External. App name, support email, **home page `<APP_URL>`**, privacy policy
   `<APP_URL>/privacy`, terms `<APP_URL>/terms`, authorized domain = your domain.
   Scopes: `youtube.upload`, `youtube.readonly`, `youtube.force-ssl`.
3. Credentials > Create OAuth client ID > Web application:
   - Authorized redirect URI: `<APP_URL>/api/oauth/youtube/callback`
   - Authorized JavaScript origin: `<APP_URL>`
   Copy the ids to `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
4. **Publishing status matters:** in *Testing*, Google expires refresh tokens after **7 days** (YouTube would disconnect
   every week). Set the status to **In production**. Until Google verifies the app, up to 100 people can use it after
   clicking through an "unverified app" screen; submit the app for verification to remove that.
5. Quota: the default is 10,000 units/day. A video upload costs about 1,600, a comment reply 50, a comment check 1–2.
   Ask for more in the console when you have many users.
6. The Google account needs a YouTube channel. YouTube posts must have a video; the first line of the text is the title.

## 9. LinkedIn [YOU]
1. linkedin.com/developers/apps > Create app. LinkedIn requires a Company Page to associate the app with (create a simple
   one if you have none); the app still posts to **your personal profile**.
2. Products tab: add **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect** (both approved instantly).
3. Auth tab: Authorized redirect URL `<APP_URL>/api/oauth/linkedin/callback`. Copy Client ID / Primary Client Secret to
   `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET`.
4. Connections last 60 days and LinkedIn does not let apps renew them: the dashboard warns a week before, and **Reconnect**
   takes one click.
5. Optional, for post stats and reading comments: apply for the **Community Management API** (Products tab). LinkedIn reviews
   it (registered business, use-case description, screencast; LinkedIn may ask for a separate app for it). Once approved,
   set `LINKEDIN_EXTRA_SCOPES=r_member_social r_member_postAnalytics` and reconnect LinkedIn. Until then the app is honest
   about it: LinkedIn posts publish, and the dashboard and inbox say stats and comments need LinkedIn's approval.

## 10. Deploy and give yourself the Premium plan
1. Vercel > Deployments > Redeploy (so every variable is picked up). `npm run doctor` locally with the same values must show no ✗.
2. Open `<APP_URL>`, sign up.
3. Billing is not built yet, so plans are set by hand. The Free plan allows 2 accounts and 10 posts a month; Premium allows
   5 accounts and unlimited posts. With `DATABASE_URL` pointing at the live database:
   `npm run plan:set -- you@example.com premium`
4. `<APP_URL>/api/health` should answer `{"ok":true,"db":true}`. Point an uptime monitor at it.

## 11. First run: what to test, in order
1. Sign up -> `/dashboard` loads.
2. Accounts -> Connect Instagram, YouTube, LinkedIn. Each shows your real name and photo.
3. Post now, one photo, to Instagram + LinkedIn. Both show Published with a link within a minute.
4. Schedule a video to YouTube 10 minutes out. The Inngest dashboard shows a sleeping `publish-post` run; it publishes on time.
5. Drag a scheduled post on the calendar; the old run is cancelled and the new time is used.
6. Comment on your Instagram post and your YouTube video from another account. Inbox > **Sync now** shows them; reply to each
   and check the reply appears on the platform.
7. A few hours later the dashboard's Engagement card shows likes, comments and views per platform.
8. **Collaborators** (Instagram): post a photo with one collaborator (an account you control) -> the post publishes,
   the collaborator gets an invite in Instagram, and after accepting, the post shows on both profiles. Repeat once with
   a reel and once with a carousel. Expect an error, not a crash, for a username that does not exist or is private.
   All posts > open the post: under the Instagram account, **Collaborators** shows what Instagram reports for each
   invite (Accepted / waiting / Declined / "Instagram has no invite for this account").
10. **Delete on Instagram**: All posts > open a published Instagram test post > Delete > tick "Also delete it on
   Instagram" > Delete. It disappears from Instagram and from Social Copilot. If Meta refuses, the post stays in Social
   Copilot and the message says why.
9. **Messages** (Instagram): from another account, DM your Instagram account. Inbox > Messages > it appears (open the
   tab or press Sync now). Open it, reply once, and check it arrives in Instagram; it must appear **once** in the
   thread after the next sync (no duplicate). Double-click Send on a second reply: it must arrive once. A conversation
   whose last message from them is over 24 hours old shows "Instagram only allows replies within 24 hours of their
   last message." with no reply box.

## Local development (optional)
- `npm run demo` (needs a local Postgres: `docker compose up -d db`): the full app with sample data and a built-in demo user,
  no keys needed. Publishing fails there with the platform's "invalid token" error, by design.
- With real keys: `cp .env.example .env.local`, fill it in, `npm run db:push`, `npm run dev`, and in a second terminal
  `npm run inngest:dev` (keep `INNGEST_DEV=1` locally). Instagram and LinkedIn only redirect to https: run `ngrok http 3000`,
  set `NEXT_PUBLIC_APP_URL` to the ngrok URL, and add that URL's callbacks in each console (`npm run doctor` prints them).
