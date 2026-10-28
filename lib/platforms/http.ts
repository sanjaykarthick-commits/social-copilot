import { PlatformError } from "@/lib/platforms/types";

/** Pull the most useful human-readable message out of a platform error body. */
export function extractMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return typeof body === "string" && body ? body.slice(0, 300) : fallback;
  const b = body as Record<string, unknown>;
  const errors = Array.isArray(b.errors) ? (b.errors as Record<string, unknown>[]) : [];
  const nested = (b.error && typeof b.error === "object" ? (b.error as Record<string, unknown>) : undefined) ?? undefined;
  const candidates = [
    b.detail,
    b.error_description,
    nested?.message,
    errors[0]?.message,
    errors[0]?.detail,
    b.title,
    typeof b.error === "string" ? b.error : undefined,
    b.message,
  ];
  const found = candidates.find((c): c is string => typeof c === "string" && c.length > 0);
  return (found ?? fallback).slice(0, 400);
}

export async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Map an HTTP failure to a PlatformError the pipeline can reason about.
 * 401 -> reconnect, 429 -> retry later, 5xx -> retry, other 4xx -> show the message.
 */
export function errorFromResponse(res: Response, body: unknown, context: string): PlatformError {
  const message = extractMessage(body, `${context} failed (${res.status})`);
  if (res.status === 401) return new PlatformError(`${context}: ${message}. Reconnect the account.`, "auth", false, 401);
  if (res.status === 429) return new PlatformError(`${context}: rate limited, will retry. ${message}`, "rate_limit", true, 429);
  if (res.status >= 500) return new PlatformError(`${context}: ${message}`, "api", true, res.status);
  return new PlatformError(`${context}: ${message}`, "api", false, res.status);
}

/** fetch with a timeout; network failures become retryable PlatformErrors. */
export async function safeFetch(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 30_000, ...rest } = init;
  try {
    return await fetch(url, { ...rest, signal: rest.signal ?? AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new PlatformError(`Network error calling ${new URL(url).host}: ${reason}`, "api", true);
  }
}
