import {
  FaBluesky,
  FaFacebook,
  FaInstagram,
  FaLinkedin,
  FaPinterest,
  FaThreads,
  FaTiktok,
  FaXTwitter,
  FaYoutube,
} from "react-icons/fa6";
import type { IconType } from "react-icons";
import type { Platform } from "@/lib/constants";
import { PLATFORM_META } from "@/lib/platforms/meta";
import { cn } from "@/lib/utils";

const ICONS: Record<Platform, IconType> = {
  twitter: FaXTwitter,
  youtube: FaYoutube,
  linkedin: FaLinkedin,
  instagram: FaInstagram,
  tiktok: FaTiktok,
  facebook: FaFacebook,
  threads: FaThreads,
  pinterest: FaPinterest,
  bluesky: FaBluesky,
};

/** Brand glyph, plain. */
export function PlatformGlyph({ platform, className }: { platform: Platform; className?: string }) {
  const Icon = ICONS[platform];
  return <Icon className={className} aria-hidden />;
}

/** Brand glyph on its brand-colored rounded tile. */
export function PlatformIcon({ platform, className }: { platform: Platform; className?: string }) {
  return (
    <span
      className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl text-white", className)}
      style={{ backgroundColor: PLATFORM_META[platform].color }}
      title={PLATFORM_META[platform].name}
    >
      <PlatformGlyph platform={platform} className="size-5" />
    </span>
  );
}
