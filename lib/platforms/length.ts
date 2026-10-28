import type { Platform } from "@/lib/constants";
import { PLATFORM_META } from "@/lib/platforms/meta";

const URL_RE = /https?:\/\/[^\s]+/gi;
const X_URL_WEIGHT = 23;

/**
 * Weighted length as X counts it: every URL is 23 characters, characters in the
 * Latin/punctuation ranges weigh 1, everything else (CJK, emoji, ...) weighs 2.
 */
export function countXChars(text: string): number {
  let urls = 0;
  const stripped = text.replace(URL_RE, () => {
    urls += 1;
    return "";
  });
  let total = urls * X_URL_WEIGHT;
  for (const ch of stripped.normalize("NFC")) {
    const cp = ch.codePointAt(0)!;
    const light =
      (cp >= 0 && cp <= 4351) || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247);
    total += light ? 1 : 2;
  }
  return total;
}

/** Length of `text` as the given platform counts it. */
export function countChars(platform: Platform, text: string): number {
  return platform === "twitter" ? countXChars(text) : [...text].length;
}

export function charsRemaining(platform: Platform, text: string): number {
  return PLATFORM_META[platform].maxChars - countChars(platform, text);
}

/** YouTube: first non-empty line is the title (max 100), the full text is the description. */
export function youtubeTitle(content: string): string {
  const first = content.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "Untitled";
  return [...first].slice(0, 100).join("");
}
