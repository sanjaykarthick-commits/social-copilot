import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Only dashboard pages are gated here. API routes authorize themselves with
// auth() and answer with the standard JSON error shape (a redirect or 404 from
// the proxy would be a poor answer to fetch()). Webhook and Inngest routes stay public.
const isProtectedPage = createRouteMatcher(["/dashboard(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedPage(req)) await auth.protect();
});

export const config = {
  matcher: [
    // Skip Next internals and static files
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
