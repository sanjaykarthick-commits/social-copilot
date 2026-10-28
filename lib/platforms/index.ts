import { PLATFORMS, type Platform } from "@/lib/constants";
import { instagramAdapter } from "@/lib/platforms/instagram";
import { linkedinAdapter } from "@/lib/platforms/linkedin";
import { comingSoon } from "@/lib/platforms/stubs";
import { twitterAdapter } from "@/lib/platforms/twitter";
import { youtubeAdapter } from "@/lib/platforms/youtube";
import type { PlatformAdapter } from "@/lib/platforms/types";

const implemented: Partial<Record<Platform, PlatformAdapter>> = {
  twitter: twitterAdapter,
  youtube: youtubeAdapter,
  instagram: instagramAdapter,
  linkedin: linkedinAdapter,
};

/** Every platform has an adapter; unbuilt ones report `implemented: false`. */
export function getAdapter(platform: Platform): PlatformAdapter {
  return implemented[platform] ?? comingSoon(platform);
}

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}
