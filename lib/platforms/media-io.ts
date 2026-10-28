import { PlatformError, type PublishMedia } from "@/lib/platforms/types";
import { safeFetch } from "@/lib/platforms/http";

/**
 * Shared helpers for adapters that must stream user media to a platform. The
 * source is always our ImageKit CDN (enforced when media is registered), and the
 * file is read in slices with Range requests so a large video never has to fit in memory.
 */
const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4v: "video/x-m4v",
};

export function mimeFor(m: PublishMedia): string {
  if (m.mimeType) return m.mimeType;
  const ext = new URL(m.url).pathname.split(".").pop()?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || (m.type === "video" ? "video/mp4" : "image/jpeg");
}

/** An ImageKit URL with a transformation applied (e.g. "f-jpg" to convert to JPEG on the fly). */
export function withTransform(url: string, tr: string): string {
  const u = new URL(url);
  u.searchParams.set("tr", tr);
  return u.toString();
}

/** Download a whole (small) file, e.g. an image. */
export async function readAll(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await safeFetch(url, { timeoutMs: 60_000 });
  if (!res.ok) throw new PlatformError(`Could not read media (${res.status}).`, "api", res.status >= 500);
  return new Uint8Array(await res.arrayBuffer());
}

export async function mediaSize(m: PublishMedia): Promise<number> {
  if (m.sizeBytes && m.sizeBytes > 0) return m.sizeBytes;
  const head = await safeFetch(m.url, { method: "HEAD" });
  const len = Number(head.headers.get("content-length"));
  if (!Number.isFinite(len) || len <= 0) throw new PlatformError(`Could not determine the size of ${m.url}.`, "api", true);
  return len;
}

/** Download bytes [start, endInclusive] (falls back to slicing a full response if Range is ignored). */
export async function readSlice(url: string, start: number, endInclusive: number): Promise<Uint8Array<ArrayBuffer>> {
  const res = await safeFetch(url, { headers: { Range: `bytes=${start}-${endInclusive}` }, timeoutMs: 60_000 });
  if (res.status !== 206 && res.status !== 200) {
    throw new PlatformError(`Could not read media (${res.status}).`, "api", res.status >= 500);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return res.status === 206 ? buf : buf.slice(start, endInclusive + 1);
}
