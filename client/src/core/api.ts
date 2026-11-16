// Local implementation of the /api/* endpoints the shared web UI (app/static/app.js) calls.
import { env, http, SourceError } from "./env";
import { now } from "./db";
import * as queries from "./queries";
import * as settingsMod from "./settings";
import { listProviders } from "./justwatch";
import { manager } from "./sync";

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

// --- version: newest app-v0.x.y tag on GitHub -------------------------------------------------
const versionCache = { at: 0, latest: null as string | null, error: null as string | null };
const parseV = (v?: string | null) => {
  const m = /^(?:app-)?v?(\d+)\.(\d+)\.(\d+)$/.exec((v || "").trim());
  return m ? m.slice(1).map(Number) : null;
};
const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

async function versionStatus(force: boolean) {
  const age = now() - versionCache.at;
  if (age > 300 || (force && age > 60)) {
    try {
      const r = await http(`https://api.github.com/repos/${env.repo}/tags`, { params: { per_page: 100 },
        headers: { Accept: "application/vnd.github+json" }, timeoutMs: 10000 });
      if (!r.ok) throw new SourceError(`GitHub HTTP ${r.status}`);
      const vs = (r.data || []).map((t: any) => String(t.name)).filter((n: string) => n.startsWith("app-v"))
        .map(parseV).filter(Boolean) as number[][];
      versionCache.latest = vs.length ? vs.sort(cmp).pop()!.join(".") : null;
      versionCache.error = null;
    } catch (e) { versionCache.error = String((e as Error).message || e); }
    versionCache.at = now();
  }
  const cur = parseV(env.version), latest = parseV(versionCache.latest);
  const state = !cur || !latest || versionCache.error ? "unknown" : cmp(latest, cur) > 0 ? "update" : "current";
  return { current: env.version, latest: versionCache.latest, state, error: versionCache.error,
    url: `https://github.com/${env.repo}/releases` };
}

export async function handle(method: string, path: string, q: URLSearchParams, body: any): Promise<unknown> {
  const db = env.db;
  const route = `${method} ${path}`;
  switch (route) {
    case "GET /api/auth/state":
      return { configured: true, logged_in: true, version: env.version, local: true };
    case "GET /api/onboarding":
      return { pending: await db.kvGet("onboarding.pending", true) };
    case "POST /api/onboarding/done":
      await db.kvSet("onboarding.pending", false);
      return { ok: true };
    case "GET /api/version":
      return versionStatus(q.get("refresh") === "1");
    case "GET /api/catalog":
      return queries.catalog(Object.fromEntries(q) as any);
    case "GET /api/facets":
      return queries.facets();
    case "GET /api/providers":
      return { items: await queries.providers() };
    case "GET /api/stats":
      return queries.stats();
    case "GET /api/settings":
      return settingsMod.masked(await settingsMod.load());
    case "PUT /api/settings": {
      const before = await settingsMod.load();
      const saved = await settingsMod.save(body || {});
      const changed = [...(saved.justwatch.providers || [])].sort().join() !== [...(before.justwatch.providers || [])].sort().join()
        || saved.country !== before.country || !before.justwatch.enabled;
      if (saved.justwatch.enabled && saved.justwatch.providers.length && changed) manager.trigger("justwatch");
      return settingsMod.masked(saved);
    }
    case "GET /api/justwatch/providers": {
      const s = await settingsMod.load();
      try { return { items: await listProviders(q.get("country") || s.country) }; }
      catch (e) { throw new ApiError(502, `JustWatch nedostupný: ${(e as Error).message}`); }
    }
    case "GET /api/sync/status":
      return { jobs: await manager.status(), last_full: await db.kvGet("sync.last_full", 0), running: manager.running.size > 0,
        budgets: Object.fromEntries(await Promise.all(["sa", "csfd", "mdblist", "omdb"].map(async (n) => [n, await db.budgetUsed(n)]))) };
    case "GET /api/sync/progress":
    {
      const jobs = await manager.status();
      return { running: jobs.filter((j) => j.running).map((j) => ({ id: j.id, label: j.label, running: true,
        progress: { phase: j.progress!.phase, percent: j.progress!.percent } })),
      queued: jobs.filter((j) => j.queued).length, first: !(await db.kvGet("sync.last_full", 0)) };
    }
    case "POST /api/sync":
      manager.trigger(q.get("job"));
      return { ok: true };
    case "GET /api/health":
      return { ok: true };
  }
  throw new ApiError(404, "V aplikaci není k dispozici.");
}

/** fetch() replacement for same-origin /api/* calls; everything else goes to the real fetch. */
export function installFetchShim(): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return realFetch(input as any, init);
    const method = (init?.method || "GET").toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    try {
      const data = await handle(method, url.pathname, url.searchParams, body);
      return new Response(JSON.stringify(data ?? null), { status: 200, headers: { "Content-Type": "application/json" } });
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500;
      if (!(e instanceof ApiError)) console.error(e);
      return new Response(JSON.stringify({ detail: (e as Error)?.message || String(e) }), { status, headers: { "Content-Type": "application/json" } });
    }
  };
}
