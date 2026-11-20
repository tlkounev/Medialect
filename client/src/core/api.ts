// Local implementation of the /api/* endpoints the shared web UI (app/static/app.js) calls.
import { env, http, SourceError } from "./env";
import { now } from "./db";
import * as queries from "./queries";
import * as settingsMod from "./settings";
import { listProviders } from "./justwatch";
import * as ivysilani from "./ivysilani";
import { manager } from "./sync";
import { testServer } from "./servers";
import * as remoteMod from "./remote";

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
    // the exact release: GitHub's "Latest" badge stays on the last desktop release (its updater feed)
    url: `https://github.com/${env.repo}/releases${versionCache.latest ? `/tag/app-v${versionCache.latest}` : ""}` };
}

export async function handle(method: string, path: string, q: URLSearchParams, body: any): Promise<unknown> {
  const db = env.db;
  const route = `${method} ${path}`;
  // the refresh button on a title: that title again from every source and all its ratings, now
  const refresh = route.match(/^POST \/api\/titles\/(\d+)\/refresh$/);
  if (refresh) {
    const id = Number(refresh[1]);
    const { refreshTitle } = await import("./refresh");
    const notes = await refreshTitle(id);
    const [item] = await queries.hydrate([id]);
    if (!item) throw new ApiError(404, "Titul nenalezen.");
    return { ...item, refresh_note: notes.join(" · ") || null };
  }
  const del = route.match(/^DELETE \/api\/servers\/([^/]+)$/);
  if (del) {
    const id = decodeURIComponent(del[1]);
    const removed = await settingsMod.deleteServer(id);
    if (!removed) throw new ApiError(404, "Server nenalezen.");
    await db.run("DELETE FROM availability WHERE source=?", [`${removed.type}:${id}`]);
    await db.run("DELETE FROM sync_runs WHERE source=?", [`server:${id}`]);
    return { ok: true };
  }
  // connecting to a Medialect server (the app's own, never forwarded)
  switch (route) {
    case "GET /api/app/connection": {
      const r = remoteMod.currentRemote();
      return r ? { mode: "server", url: r.url, public: r.public, role: r.role } : { mode: "standalone" };
    }
    case "POST /api/app/connect":
      try {
        const r = await remoteMod.connect(String(body?.url || ""), String(body?.password || ""));
        await db.kvSet("onboarding.pending", false);
        return { mode: "server", url: r.url, public: r.public, role: r.role };
      } catch (e) { throw new ApiError(400, (e as Error).message); }
    case "GET /api/app/server-version": {
      // the server's own version and whether a newer image is out (asks the server; 502 = not answering)
      if (!remoteMod.currentRemote()) throw new ApiError(400, "Not connected.");
      const r = await remoteMod.forward("GET", "/api/version", undefined);
      const data = await r.json().catch(() => ({}));
      return r.ok ? { ...data, reachable: true, via: r.headers.get("X-Medialect-Via") || "home" } : { reachable: false, detail: data?.detail };
    }
    case "POST /api/app/disconnect":
      await remoteMod.disconnect();
      return { mode: "standalone" };
  }
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
      // iVysílání has its own source: picking it alone does not start JustWatch again
      const jw = (s: typeof saved) => queries.jwProviders(s.justwatch.providers).sort().join();
      const changed = jw(saved) !== jw(before) || saved.country !== before.country || !before.justwatch.enabled;
      if (saved.justwatch.enabled && jw(saved) && changed) manager.trigger("justwatch");
      if (ivysilani.selected(saved) && !ivysilani.selected(before)) manager.trigger("ivysilani");
      await manager.triggerNewServers();
      return settingsMod.masked(saved);
    }
    case "POST /api/servers": {
      let srv, changed;
      try { [srv, changed] = await settingsMod.saveServer(body || {}); }
      catch (e) { throw new ApiError(400, (e as Error).message); }
      if (changed && srv.enabled !== false) manager.trigger(`server:${srv.id}`);
      return settingsMod.masked({ servers: [srv] } as any).servers[0];
    }
    case "POST /api/servers/test": {
      const srv = { ...(body || {}) };
      if (srv.token === settingsMod.MASK) {
        srv.token = ((await settingsMod.load()).servers || []).find((x: any) => x.id === srv.id)?.token || "";
      }
      srv.id ||= "test";
      try { return { ok: true, info: await testServer(srv) }; }
      catch (e) { return { ok: false, error: (e as Error).message || String(e) }; }
    }
    case "GET /api/justwatch/providers": {
      const s = await settingsMod.load();
      const c = q.get("country") || s.country;
      try { return { items: await ivysilani.register(c, await listProviders(c)) }; }
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
    case "POST /api/ratings/focus": {
      // the titles the viewer has on screen, in display order: their ratings are fetched first
      const ids = ((body?.ids || []) as unknown[]).slice(0, 200).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      await db.kvSet("ratings.focus", { ids, v: now() });
      return { ok: true };
    }
    case "POST /api/sync":
      manager.trigger(q.get("job"));
      return { ok: true };
    case "GET /api/health":
      return { ok: true };
  }
  throw new ApiError(404, "V aplikaci není k dispozici.");
}

/** Server mode: what the app answers itself (undefined = ask the server). */
async function remoteLocal(method: string, path: string): Promise<unknown> {
  const route = `${method} ${path}`;
  if (route === "GET /api/auth/state") {
    // the app is logged in for the user; the role says what the server allows (null: log in again)
    const role = await remoteMod.remoteRole();
    const r = remoteMod.currentRemote()!;
    return { configured: true, local: true, remote: { url: r.url, offline: role === "offline", via: remoteMod.lastVia() },
      role: role === "offline" ? r.role : role, logged_in: (role === "offline" ? r.role : role) === "admin", version: env.version };
  }
  if (route === "GET /api/onboarding") return { pending: false };       // set up on the server
  if (route === "POST /api/onboarding/done") return { ok: true };
  return undefined;
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
    // server mode: everything but the app's own things goes to the server
    if (remoteMod.currentRemote()) {
      const local = await remoteLocal(method, url.pathname);
      if (local !== undefined) return new Response(JSON.stringify(local), { status: 200, headers: { "Content-Type": "application/json" } });
      if (!url.pathname.startsWith("/api/app/") && url.pathname !== "/api/version") return remoteMod.forward(method, url.pathname + url.search, body);
    }
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
