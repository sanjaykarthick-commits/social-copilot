# Decisions

Format: `YYYY-MM-DD | decision | reason | alternatives rejected`. Newest first.

2026-10-27 | Main platforms: Instagram, YouTube, LinkedIn (X kept) | user asked for these three, with scheduling, stats and comment replies | –
2026-10-27 | Instagram through "Instagram API with Instagram Login" | works with Business/Creator accounts without a Facebook Page; publish, insights and comments in one product | Facebook Login (needs a Page link)
2026-10-27 | LinkedIn uses only self-serve products (OpenID + Share on LinkedIn); stats and comment reading switch on per account only when LINKEDIN_EXTRA_SCOPES grants r_member_postAnalytics / r_member_social | LinkedIn restricts those scopes to approved Community Management API apps; publishing must work for everyone | pretending stats exist, scraping
2026-10-27 | Comment inbox: poll (cron + "Sync now" with a 60s per-account cooldown); replies sent immediately with a browser idempotency key | webhooks need app review and a public URL; users wait for a reply result | queueing replies in Inngest
2026-10-27 | Adapters save progress (publish_state) before slow or non-idempotent steps; permanent failures clear it | Instagram/LinkedIn uploads are slow; a retry must never re-upload or post twice | re-running from scratch on retry
2026-10-27 | A LinkedIn post whose create request got no response is NOT retried automatically | could double-post; the user checks the profile | automatic retry
2026-10-27 | Instagram tokens renewed 20 days before expiry (daily job + on use); LinkedIn tokens warn and ask to reconnect | IG tokens cannot be renewed once expired; LinkedIn gives apps no refresh token | –
2026-10-27 | AI features deferred | user: "No need to add AI features now" | –
2026-10-27 | One plan key: free / premium; limits only in lib/plans.ts | spec pitfall (pro vs premium) | –
2026-10-27 | Scheduling: DB token per schedule; send new event, then cancel old; one Inngest function for "now" and "schedule" | a post can never be published twice or at an old time | trusting Inngest run state
2026-10-27 | Next.js 16: proxy.ts, Cache Components off | every dashboard page reads the session | –
