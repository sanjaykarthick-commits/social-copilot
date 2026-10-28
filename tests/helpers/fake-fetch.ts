import { vi } from "vitest";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  bodyBytes?: number;
}

type Handler = (req: RecordedRequest) => Response | Promise<Response> | undefined;

const lower = (h: HeadersInit | undefined) => {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => (out[k.toLowerCase()] = v));
  return out;
};

/**
 * Installs a fake global fetch. Handlers run in order; the first to return a Response wins.
 * Requests are recorded so tests can assert on exactly what an adapter sent.
 */
export function installFakeFetch(handlers: Handler[]) {
  const requests: RecordedRequest[] = [];
  const fake = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let body: unknown = init.body;
    let bodyBytes: number | undefined;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body; // form-encoded
      }
    } else if (init.body instanceof FormData) {
      body = Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, v instanceof Blob ? `<blob ${v.size}b>` : v]));
    } else if (init.body && typeof (init.body as Uint8Array).byteLength === "number") {
      bodyBytes = (init.body as Uint8Array).byteLength;
      body = `<${bodyBytes} bytes>`;
    }
    const req: RecordedRequest = { method: (init.method ?? "GET").toUpperCase(), url, headers: lower(init.headers), body, bodyBytes };
    requests.push(req);
    for (const h of handlers) {
      const r = await h(req);
      if (r) return r;
    }
    return new Response(JSON.stringify({ detail: `unexpected request ${req.method} ${url}` }), { status: 599 });
  });
  vi.stubGlobal("fetch", fake);
  return { requests, fake };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Serves ranged GETs of a synthetic file (the ImageKit CDN stand-in). */
export function cdn(host: string, sizes: Record<string, number>): Handler {
  return (req) => {
    const u = new URL(req.url);
    if (u.host !== host) return undefined;
    const total = sizes[u.pathname];
    if (total === undefined) return new Response("nope", { status: 404 });
    const m = req.headers.range?.match(/bytes=(\d+)-(\d+)/);
    if (!m) return new Response(new Uint8Array(total), { status: 200 });
    const [start, end] = [Number(m[1]), Math.min(Number(m[2]), total - 1)];
    return new Response(new Uint8Array(end - start + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${total}` } });
  };
}
