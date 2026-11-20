// "Server" mode: the app shows the catalogue of the user's Medialect server (Docker) instead of its own.
// The app logs in with a password (the admin password opens everything, the connection password only the
// catalogue), keeps the session and sends it as a Bearer header. At home it uses the address the user gave,
// elsewhere the server's public address (set on the server).
import { env, SourceError } from "./env";

export interface Remote {
  url: string;           // the address the user connected with
  public: string;        // the server's public address ("" = none)
  session: string;
  role: "admin" | "viewer";
}

let remote: Remote | null = null;
let good = "";           // the address that answered last
let goodAt = 0;

// the development preview in a plain browser keeps its database in memory: the connection survives a
// reload in sessionStorage there
const preview = () => typeof window !== "undefined" && !(window as any).__TAURI_INTERNALS__ && typeof sessionStorage !== "undefined";

export async function loadRemote(): Promise<Remote | null> {
  remote = await env.db.kvGet<Remote | null>("remote", null);
  if (!remote && preview()) { try { remote = JSON.parse(sessionStorage.getItem("medialect.remote") || "null"); } catch { remote = null; } }
  return remote;
}
async function saveRemote(r: Remote | null): Promise<void> {
  await env.db.kvSet("remote", r);
  if (preview()) { if (r) sessionStorage.setItem("medialect.remote", JSON.stringify(r)); else sessionStorage.removeItem("medialect.remote"); }
  remote = r;
}
export const currentRemote = () => remote;
/** "public" when the server's public address answered last, else "home". */
export const lastVia = () => (remote?.public && good === clean(remote.public) && good !== clean(remote.url) ? "public" : "home");

const clean = (u: string) => u.trim().replace(/\/+$/, "");

function bases(): string[] {
  if (!remote) return [];
  const all = [...new Set([remote.url, remote.public].filter(Boolean).map(clean))];
  // the address that answered last first; after 5 minutes both are tried in order again (home <-> outside)
  if (good && Date.now() - goodAt < 300_000) all.sort((a, b) => (b === good ? 1 : 0) - (a === good ? 1 : 0));
  return all;
}

async function call(base: string, method: string, path: string, body: unknown, session: string | null, timeoutMs: number) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (session) headers.Authorization = `Bearer ${session}`;
    let payload: string | undefined;
    if (body !== undefined) { payload = JSON.stringify(body); headers["Content-Type"] = "application/json"; }
    return await env.fetch(base + path, { method, headers, body: payload, signal: ctl.signal });
  } finally { clearTimeout(timer); }
}

/** Images (posters, server icons) cannot send the header: the session goes into their address. */
function absolutize(data: any, base: string, session: string): any {
  const fix = (v: unknown) => typeof v === "string" && v.startsWith("/api/")
    ? `${base}${v}${v.includes("?") ? "&" : "?"}s=${encodeURIComponent(session)}` : v;
  const walk = (x: any): any => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      for (const k of Object.keys(x)) x[k] = (k === "poster" || k === "icon") ? fix(x[k]) : walk(x[k]);
    }
    return x;
  };
  return walk(data);
}

/** One API call to the server: the home address or the public one, whichever answers. */
export async function forward(method: string, pathAndQuery: string, body: unknown): Promise<Response> {
  const r0 = remote!;
  let lastErr: unknown = null;
  const list = bases();
  // the refresh button asks every source and rating site for one title: it takes many seconds, so the address
  // is found first by a short question, and only then the long call is made (once: never twice on the server)
  const slow = method === "POST" && /\/refresh$/.test(pathAndQuery.split("?")[0]);
  for (const [i, base] of list.entries()) {
    try {
      // a short wait for the first address: away from home its answer never comes
      const wait = i < list.length - 1 ? 4000 : 20000;
      if (slow) await call(base, "GET", "/api/version", undefined, r0.session, wait);
      const r = await call(base, method, pathAndQuery, body, r0.session, slow ? 120000 : wait);
      good = base; goodAt = Date.now();
      const text = await r.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { detail: text.slice(0, 200) }; }
      if (r.ok) data = absolutize(data, base, r0.session);
      // which address answered: the home one the user gave, or the server's public one
      const via = r0.public && base === clean(r0.public) && base !== clean(r0.url) ? "public" : "home";
      return new Response(JSON.stringify(data), { status: r.status, headers: { "Content-Type": "application/json", "X-Medialect-Via": via } });
    } catch (e) { lastErr = e; }
  }
  const msg = `Server Medialect nedostupný (${(lastErr as Error)?.message || lastErr}).`;
  return new Response(JSON.stringify({ detail: msg }), { status: 502, headers: { "Content-Type": "application/json" } });
}

/** Log in to a server: on success the app works with it from the next start. */
export async function connect(url: string, password: string): Promise<Remote> {
  const base = clean(/^https?:\/\//i.test(url) ? url : `http://${url}`);
  let r: Response;
  try { r = await call(base, "POST", "/api/auth/login", { password }, null, 15000); }
  catch (e) { throw new SourceError(`Server ${base} nedostupný: ${(e as Error)?.message || e}`); }
  const data = await r.json().catch(() => null);
  if (r.status === 401) throw new SourceError("Špatné heslo.");
  if (!r.ok || !data?.session) throw new SourceError(data?.detail || `Server ${base} neodpověděl jako Medialect (HTTP ${r.status}).`);
  const st = await (await call(base, "GET", "/api/auth/state", undefined, data.session, 15000)).json().catch(() => ({}));
  const next: Remote = { url: base, public: clean(st?.public_url || ""), session: data.session, role: data.role };
  await saveRemote(next);
  return next;
}

export async function disconnect(): Promise<void> {
  await saveRemote(null);
}

/** The role on the server now (the session may have ended: a changed password); null = log in again. */
export async function remoteRole(): Promise<"admin" | "viewer" | null | "offline"> {
  if (!remote) return null;
  const r = await forward("GET", "/api/auth/state", undefined);
  if (r.status === 502) return "offline";
  const st = await r.json().catch(() => null);
  return st?.role ?? null;
}
