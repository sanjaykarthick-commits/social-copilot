/**
 * Our servers later download media URLs to upload them to social platforms, so a
 * client must never be able to register an arbitrary URL (SSRF / content
 * injection). Only URLs under our own ImageKit endpoint are trusted.
 */
export function isTrustedMediaUrl(candidate: string, endpoint: string): boolean {
  try {
    const u = new URL(candidate);
    const e = new URL(endpoint);
    if (u.protocol !== "https:" || e.protocol !== "https:") return false;
    if (u.host !== e.host || u.username || u.password) return false;
    const base = e.pathname.replace(/\/+$/, "");
    return u.pathname === base || u.pathname.startsWith(`${base}/`);
  } catch {
    return false;
  }
}

export const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
