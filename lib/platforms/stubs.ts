import type { Platform } from "@/lib/constants";
import { PLATFORM_META } from "@/lib/platforms/meta";
import { PlatformError, type PlatformAdapter } from "@/lib/platforms/types";

/**
 * Platforms that are on the roadmap but not built. They keep the adapter
 * interface so adding one later is a single file; the UI shows "Coming soon"
 * and never offers a fake connection.
 */
export function comingSoon(platform: Platform): PlatformAdapter {
  const fail = (): never => {
    throw new PlatformError(`${PLATFORM_META[platform].name} is not available yet.`, "config", false);
  };
  return {
    platform,
    implemented: false,
    getAuthUrl: fail,
    exchangeCode: async () => fail(),
    refreshToken: async () => fail(),
    publish: async () => fail(),
  };
}
