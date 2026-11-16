// Runtime environment shared by the core modules: database, HTTP client, version.
import type { Db } from "./db";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const env = {
  db: null as unknown as Db,
  fetch: ((u: string, i?: RequestInit) => fetch(u, i)) as Fetch,
  version: "dev",
  repo: "tlkounev/medialect",
  /** sleep is replaceable so tests run without real pauses */
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  /** called whenever a sync job starts, reports progress or ends (Android: background notification) */
  onActivity: () => {},
};

export class SourceError extends Error {}

export const userAgent = () => `Medialect-App/${env.version} (+https://github.com/${env.repo})`;

export interface HttpResult { status: number; ok: boolean; data: any; text: string; url: string; headers: Headers }

/** GET/POST with query params; JSON is parsed when the response is JSON. Network errors throw SourceError. */
export async function http(url: string, opts: { params?: Record<string, unknown>; method?: string; headers?: Record<string, string>;
  json?: unknown; timeoutMs?: number } = {}): Promise<HttpResult> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(opts.params || {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  const headers: Record<string, string> = { "User-Agent": userAgent(), ...(opts.headers || {}) };
  let body: string | undefined;
  if (opts.json !== undefined) { body = JSON.stringify(opts.json); headers["Content-Type"] = "application/json"; }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 30000);
  let r: Response;
  try {
    r = await env.fetch(u.toString(), { method: opts.method || (body ? "POST" : "GET"), headers, body, signal: ctl.signal });
  } catch (e) {
    throw new SourceError(`${u.host}: ${(e as Error)?.message || e}`);
  } finally { clearTimeout(timer); }
  const text = await r.text();
  let data: any = null;
  if ((r.headers.get("content-type") || "").includes("json") || /^\s*[[{]/.test(text)) {
    try { data = JSON.parse(text); } catch { /* not JSON after all */ }
  }
  return { status: r.status, ok: r.ok, data, text, url: r.url || u.toString(), headers: r.headers };
}
