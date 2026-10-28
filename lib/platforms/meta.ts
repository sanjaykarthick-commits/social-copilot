import type { Platform } from "@/lib/constants";

/**
 * Client-safe platform metadata (no env, no secrets). The adapters in
 * lib/platforms/*.ts hold the server-side implementations.
 */
export interface PlatformMeta {
  id: Platform;
  name: string;
  /** Chip / badge color used by the calendar and charts. */
  color: string;
  implemented: boolean;
  /** Character limit for the post body (X: weighted, see lib/platforms/length.ts). */
  maxChars: number;
  maxImages: number;
  supportsImages: boolean;
  supportsVideo: boolean;
  /** Platform requires a video to publish at all. */
  requiresVideo?: boolean;
  /** Platform cannot publish text-only posts (a photo or video is required). */
  requiresMedia?: boolean;
  /** Social Copilot can delete a published post on the platform itself (adapter.deletePost). */
  deletesPosts?: boolean;
  blurb: string;
}

export const PLATFORM_META: Record<Platform, PlatformMeta> = {
  twitter: {
    id: "twitter",
    name: "X (Twitter)",
    color: "#0f1419",
    implemented: true,
    maxChars: 280,
    maxImages: 4,
    supportsImages: true,
    supportsVideo: true,
    blurb: "Publish posts with up to 4 images or a video.",
  },
  youtube: {
    id: "youtube",
    name: "YouTube",
    color: "#ff0000",
    implemented: true,
    maxChars: 5000,
    maxImages: 0,
    supportsImages: false,
    supportsVideo: true,
    requiresVideo: true,
    blurb: "Upload videos. The first line becomes the title, the rest the description.",
  },
  linkedin: {
    id: "linkedin",
    name: "LinkedIn",
    color: "#0a66c2",
    implemented: true,
    maxChars: 3000,
    maxImages: 10,
    supportsImages: true,
    supportsVideo: true,
    blurb: "Post to your profile: text, photos or a video.",
  },
  instagram: {
    id: "instagram",
    name: "Instagram",
    color: "#e1306c",
    implemented: true,
    maxChars: 2200,
    maxImages: 10,
    supportsImages: true,
    supportsVideo: true,
    requiresMedia: true,
    deletesPosts: true,
    blurb: "Photos, carousels and reels. Needs a Business or Creator account.",
  },
  tiktok: {
    id: "tiktok",
    name: "TikTok",
    color: "#00b8b0",
    implemented: false,
    maxChars: 2200,
    maxImages: 0,
    supportsImages: false,
    supportsVideo: true,
    requiresVideo: true,
    blurb: "Short-form video.",
  },
  facebook: {
    id: "facebook",
    name: "Facebook",
    color: "#1877f2",
    implemented: false,
    maxChars: 5000,
    maxImages: 10,
    supportsImages: true,
    supportsVideo: true,
    blurb: "Pages and groups.",
  },
  threads: {
    id: "threads",
    name: "Threads",
    color: "#101010",
    implemented: false,
    maxChars: 500,
    maxImages: 10,
    supportsImages: true,
    supportsVideo: true,
    blurb: "Text-first conversations.",
  },
  pinterest: {
    id: "pinterest",
    name: "Pinterest",
    color: "#e60023",
    implemented: false,
    maxChars: 500,
    maxImages: 1,
    supportsImages: true,
    supportsVideo: true,
    blurb: "Pins and boards.",
  },
  bluesky: {
    id: "bluesky",
    name: "Bluesky",
    color: "#1185fe",
    implemented: false,
    maxChars: 300,
    maxImages: 4,
    supportsImages: true,
    supportsVideo: false,
    blurb: "Open social network.",
  },
};

export const platformName = (p: string) => PLATFORM_META[p as Platform]?.name ?? p;
export const platformColor = (p: string) => PLATFORM_META[p as Platform]?.color ?? "#64748b";
