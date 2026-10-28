/** Browser-side fetch helper that understands the server's { error: { code, message } } shape. */
export class ApiClientError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export async function api<T = unknown>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiClientError("NETWORK", "Could not reach the server. Check your connection and try again.", 0);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
    throw new ApiClientError(err?.code ?? "HTTP_ERROR", err?.message ?? `Request failed (${res.status}).`, res.status, err?.details);
  }
  return body as T;
}

export const fetcher = <T = unknown>(url: string) => api<T>(url);

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");
