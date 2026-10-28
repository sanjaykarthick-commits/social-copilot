# Design guide

Modern SaaS, calm and spacious. Light is the default; dark is complete. Read before touching UI.

## Principles
- **Honest states.** Loading skeletons, real errors with a retry, and empty states that say what to do next. Never fake numbers
  (Engagement says "Not available yet" until a platform reports real figures).
- **One accent.** The indigo -> violet gradient (`bg-brand`, `<Button variant="brand">`) is for primary calls to action only
  ("New post", "Schedule post", "Connect"). Everything else is neutral.
- **Say what is wrong and how to fix it.** Validation names the account and the limit ("@asha on X: over the 280 character limit by 20").

## Tokens (`app/globals.css`)
- Radius `0.75rem`; cards and tiles `rounded-xl`/`rounded-2xl`, controls `rounded-lg`.
- Primary `oklch(0.52 0.23 275)` (light) / `oklch(0.68 0.19 275)` (dark). Semantic: `success`, `warning`, `destructive`.
- Chart colors: published = success, scheduled = primary, failed = destructive.
- Font: Outfit (`--font-sans`), Geist Mono for code.

## Platform colors (calendar chips, glyph tiles)
X `#0f1419` (uses `--foreground` on chips so it stays visible in dark mode), YouTube `#ff0000`, LinkedIn `#0a66c2`,
Instagram `#e1306c`, TikTok `#00b8b0`, Facebook `#1877f2`. Source of truth: `lib/platforms/meta.ts`.

## Status language
Draft (grey, dashed chip) / Scheduled (primary, clock) / Publishing (amber, spinner) / Published (green, check) / Failed (red, alert).
See `components/posts/status.tsx`.

## Patterns
- Page = `PageHeader` + content, `max-w-6xl` (calendar/dashboard) or narrower for forms.
- Lists open a **drawer** (`PostDrawer`) for details and actions; destructive actions confirm with an `AlertDialog`.
- Phones: the sidebar becomes a sheet; the composer's actions pin to the bottom; the month calendar shows one **dot per post**
  (text chips do not fit in a 50px cell) and tapping a day opens the day view.
- Every list page has an empty state with a call to action.
- Inbox: one card per comment (author, platform glyph, time, text, the post it is on, replies). The primary action is
  **Reply** (brand only while the comment needs a reply); **No reply needed** archives. A failed reply stays visible with the
  platform's reason and **Try again**. Platforms that cannot share comments say so in a muted note, never an empty list.
- Inbox > Messages (Instagram DMs): conversation list (person, last message, time, a dot when they wrote last) and a
  thread pane; on phones the list and the thread are separate views with a Back button. The reply box exists only within
  24 hours of the person's last message; after that a muted note says "Instagram only allows replies within 24 hours of
  their last message." with a link to Instagram. A failed send stays in the thread with the reason and **Try again**.
- Connection health: a disconnected account, or one that only the user can renew (LinkedIn, 60 days), shows an amber banner
  on the dashboard a week ahead with a one-click **Reconnect**.
- Icons: lucide for UI, `react-icons/fa6` for brand glyphs (`components/platform-icon.tsx`).
- Forms use native `<select>` (`NativeSelect`) for long lists (timezones) and times: accessible and good on mobile.

## Accessibility
Interactive elements are real buttons/links with names; the account picker is a checkbox group; dialogs trap focus;
colour is never the only signal (status icons + text). Drag-and-drop has an equivalent: open the post, then **Edit**.
