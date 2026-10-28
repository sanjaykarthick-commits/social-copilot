import type { Platform } from "@/lib/constants";
import { isConfigured } from "@/lib/env";
import { PLATFORM_META } from "@/lib/platforms/meta";

/** Is this platform both built and configured (credentials present) on this server? */
export function isPlatformConfigured(platform: Platform): boolean {
  if (!PLATFORM_META[platform].implemented) return false;
  switch (platform) {
    case "twitter":
      return isConfigured("TWITTER_CLIENT_ID", "TWITTER_CLIENT_SECRET");
    case "youtube":
      return isConfigured("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET");
    case "instagram":
      return isConfigured("INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET");
    case "linkedin":
      return isConfigured("LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET");
    default:
      return false;
  }
}
