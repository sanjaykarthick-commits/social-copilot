# Decisions

Format: `YYYY-MM-DD | decision | reason | alternatives rejected`. Newest first.

2026-10-28 | "Also delete on Instagram" is opt-in per delete, platform first; any refusal keeps the post in Social Copilot; Meta's ambiguous "does not exist / missing permissions" is reported, never treated as success | deleting on Instagram cannot be undone; a post must never vanish here while still live there | auto-delete everywhere; swallowing "does not exist"

2026-10-28 | Instagram DMs read via GET /<ig-user-id>/conversations?platform=instagram on the stored host; replies POST /<ig-user-id>/messages | live probe: /me/conversations is 403 (#298) and graph.instagram.com rejects the unified-login token | /me/* edges
2026-10-28 | DMs: poll (cron 15 min + on opening the tab, 60s cooldown), no webhooks in v1; 24h window enforced in UI and API from the person's last message only; one idempotency key per draft so a double click sends once | webhooks need app review + public subscription; Meta rejects sends outside the window | queueing sends
2026-10-28 | Messages capability only when instagram_(business_)manage_messages is in the stored scopes (unknown = no) | rule 13: never claim what was not granted | assuming granted like comments
2026-10-28 | Collaborators: per post target, max 3, JSON array on the image/reel/carousel parent container only | Meta's content-publishing reference (via search summary; developers.facebook.com blocked in the session) | per-post field

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
