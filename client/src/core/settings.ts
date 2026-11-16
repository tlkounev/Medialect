// App settings, stored in the local database (port of app/settings.py).
import { env } from "./env";

export const MASK = "••••••••";

export const DEFAULTS = {
  country: "CZ",
  language: "cs",
  sync_interval_hours: 24,
  justwatch: { enabled: true, providers: [] as string[], request_delay_s: 0.5 },
  // not available in the app yet; kept so the shared UI finds the same structure
  streaming_availability: { enabled: false, mode: "direct", api_key: "", catalogs: [] as string[], daily_budget: 90 },
  servers: [] as any[],
  ratings: {
    imdb_dataset: true,
    justwatch_scores: true,
    csfd: false,                 // opt-in: ČSFD has no API, pages are read like a browser would
    csfd_daily_budget: 0,
    mdblist_api_key: "",
    mdblist_daily_budget: 900,
    tmdb_api_key: "",
    tvmaze: true,
    omdb_api_key: "",
    omdb_daily_budget: 950,
    refresh_days: 14,
  },
};
export type Settings = typeof DEFAULTS;

const SECRET_PATHS: [keyof Settings, string][] = [
  ["streaming_availability", "api_key"], ["ratings", "mdblist_api_key"], ["ratings", "tmdb_api_key"], ["ratings", "omdb_api_key"],
];

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

export function merge<T>(base: T, over: any): T {
  const out: any = structuredClone(base);
  for (const [k, v] of Object.entries(over || {})) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v;
  return out;
}

export async function load(): Promise<Settings> {
  return merge(DEFAULTS, await env.db.kvGet("settings", {}));
}

export function masked(s: Settings): Settings {
  const out: any = structuredClone(s);
  for (const [sec, key] of SECRET_PATHS) if (out[sec]?.[key]) out[sec][key] = MASK;
  for (const srv of out.servers || []) if (srv.token) srv.token = MASK;
  return out;
}

const LINK_MODES = ["auto", "public", "internal"];
const CONNECTION_KEYS = ["type", "url", "token", "enabled"];

function cleanServer(srv: any, old?: any): any {
  const out = { ...srv };
  if (!out.id) out.id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  if (out.token === MASK) out.token = old?.token || "";
  out.url = String(out.url || "").trim().replace(/\/+$/, "");
  out.public_url = String(out.public_url || "").trim().replace(/\/+$/, "");
  out.name = String(out.name || "").trim();
  out.enabled ??= true;
  if (!LINK_MODES.includes(out.link_mode)) out.link_mode = "auto";
  return out;
}

/** Add (no id) or update (with id) one media server. Returns [server, connectionChanged]. */
export async function saveServer(server: any): Promise<[any, boolean]> {
  const current = await load();
  const servers = [...(current.servers || [])];
  const idx = servers.findIndex((s) => server.id && s.id === server.id);
  const old = idx >= 0 ? servers[idx] : undefined;
  const srv = cleanServer(server, old);
  if (!srv.url) throw new Error("Chybí URL serveru.");
  if (!["emby", "jellyfin", "plex"].includes(srv.type)) throw new Error("Neznámý typ serveru.");
  if (idx >= 0) servers[idx] = srv; else servers.push(srv);
  await env.db.kvSet("settings", { ...current, servers });
  return [srv, !old || CONNECTION_KEYS.some((k) => old[k] !== srv[k])];
}

export async function deleteServer(id: string): Promise<any | null> {
  const current = await load();
  const removed = (current.servers || []).find((s) => s.id === id) || null;
  await env.db.kvSet("settings", { ...current, servers: (current.servers || []).filter((s) => s.id !== id) });
  return removed;
}

/** Save settings from the UI. Masked secrets keep their stored value. */
export async function save(update: any): Promise<Settings> {
  const current = await load();
  const merged: any = merge(current, update);
  for (const [sec, key] of SECRET_PATHS) if (merged[sec]?.[key] === MASK) merged[sec][key] = (current as any)[sec][key];
  merged.country = String(merged.country || "CZ").toUpperCase();
  const oldServers = new Map((current.servers || []).map((s: any) => [s.id, s]));
  merged.servers = (update?.servers ?? current.servers ?? []).map((s: any) => cleanServer(s, oldServers.get(s.id)));
  await env.db.kvSet("settings", merged);
  return merged;
}
