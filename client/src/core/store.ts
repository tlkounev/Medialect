// Write helpers: unify titles across sources, upsert availability and ratings (port of app/store.py).
import { env } from "./env";
import { now } from "./db";
import { norm } from "./quality";

export interface TitleInfo {
  type: "movie" | "show";
  title: string;
  original_title?: string | null;
  year?: number | null;
  poster?: string | null;
  ids?: Record<string, string | number | null | undefined>;
  extra_names?: string[];
}

export interface Offer {
  source: string;
  provider: string;
  provider_name: string;
  kind: "stream" | "library";
  monetization: string;
  quality?: string | null;
  video?: string[];
  audio?: string[];
  audio_langs?: string[];
  subtitle_langs?: string[];
  url?: string | null;
  extra?: Record<string, unknown>;
  expires_on?: string | null;
  added_at?: string | null;
}

function cleanIds(info: TitleInfo): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(info.ids || {})) {
    if (raw === null || raw === undefined || raw === "" || raw === 0 || raw === "0") continue;
    const v = String(raw).trim();
    if (k === "imdb" && !v.startsWith("tt")) continue;
    out[k] = v;
  }
  return out;
}

const namesOf = (info: TitleInfo) =>
  [...new Set([info.title, info.original_title, ...(info.extra_names || [])].filter(Boolean).map((n) => norm(n)))].filter(Boolean);

async function findTitle(info: TitleInfo, ids: Record<string, string>): Promise<number | null> {
  const db = env.db;
  // 1) exact external id match
  for (const [kind, value] of Object.entries(ids)) {
    const row = await db.get("SELECT title_id FROM title_ids WHERE kind=? AND value=?", [kind, value]);
    if (row) return row.title_id;
  }
  // 2) name + year + type, but never merge across conflicting ids
  const names = namesOf(info);
  if (!names.length || !info.year) return null;
  const cands = await db.all(
    `SELECT DISTINCT t.id FROM titles t JOIN title_names n ON n.title_id=t.id
     WHERE t.type=? AND t.year BETWEEN ? AND ? AND n.norm IN (${names.map(() => "?").join(",")}) ORDER BY ABS(t.year-?)`,
    [info.type, info.year - 1, info.year + 1, ...names, info.year]);
  for (const { id } of cands) {
    const existing: Record<string, string> = {};
    for (const r of await db.all("SELECT kind, value FROM title_ids WHERE title_id=?", [id])) existing[r.kind] = r.value;
    const conflict = Object.entries(ids).some(([k, v]) =>
      ["imdb", "tmdb_movie", "tmdb_tv", "tvdb"].includes(k) && k in existing && existing[k] !== v);
    if (!conflict) return id;
  }
  return null;
}

export async function upsertTitle(info: TitleInfo): Promise<number> {
  const db = env.db;
  const ids = cleanIds(info);
  const t = now();
  let tid = await findTitle(info, ids);
  if (tid === null) {
    tid = (await db.run("INSERT INTO titles(type, title, original_title, year, poster, created_at, updated_at) VALUES(?,?,?,?,?,?,?)",
      [info.type, info.title, info.original_title, info.year, info.poster, t, t])).lastId;
  } else {
    await db.run("UPDATE titles SET original_title=COALESCE(original_title, ?), year=COALESCE(year, ?), " +
      "poster=COALESCE(poster, ?), updated_at=? WHERE id=?", [info.original_title, info.year, info.poster, t, tid]);
  }
  for (const [kind, value] of Object.entries(ids)) {
    await db.run("INSERT OR IGNORE INTO title_ids(kind, value, title_id) VALUES(?,?,?)", [kind, value, tid]);
  }
  for (const n of namesOf(info)) await db.run("INSERT OR IGNORE INTO title_names(title_id, norm) VALUES(?,?)", [tid, n]);
  return tid;
}

export async function upsertOffer(titleId: number, o: Offer, seenAt: number): Promise<void> {
  await env.db.run(
    `INSERT INTO availability(title_id, source, provider, provider_name, kind, monetization, quality,
       video, audio, audio_langs, subtitle_langs, url, extra, expires_on, added_at, seen_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(title_id, source, provider, monetization) DO UPDATE SET
       provider_name=excluded.provider_name, kind=excluded.kind, quality=excluded.quality,
       video=excluded.video, audio=excluded.audio, audio_langs=excluded.audio_langs,
       subtitle_langs=excluded.subtitle_langs, url=excluded.url, extra=excluded.extra,
       expires_on=excluded.expires_on, added_at=COALESCE(excluded.added_at, availability.added_at),
       seen_at=excluded.seen_at`,
    [titleId, o.source, o.provider, o.provider_name, o.kind, o.monetization, o.quality ?? null,
      JSON.stringify(o.video || []), JSON.stringify(o.audio || []), JSON.stringify(o.audio_langs || []),
      JSON.stringify(o.subtitle_langs || []), o.url ?? null, JSON.stringify(o.extra || {}), o.expires_on ?? null,
      (o.added_at || "").slice(0, 19) || null, seenAt]);
}

export async function removeStale(source: string, before: number): Promise<number> {
  return (await env.db.run("DELETE FROM availability WHERE source=? AND seen_at<?", [source, before])).changes;
}

export async function setRating(titleId: number, source: string, value: number | null, display: string | null,
  votes: number | null = null, url: string | null = null, onlyIfMissing = false): Promise<void> {
  const conflict = onlyIfMissing ? "DO NOTHING"
    : "DO UPDATE SET value=excluded.value, display=excluded.display, votes=excluded.votes, " +
      "url=COALESCE(excluded.url, ratings.url), updated_at=excluded.updated_at";
  await env.db.run(`INSERT INTO ratings(title_id, source, value, display, votes, url, updated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(title_id, source) ${conflict}`, [titleId, source, value, display, votes, url, now()]);
}

export async function addTitleId(titleId: number, kind: string, value: string): Promise<void> {
  await env.db.run("INSERT OR IGNORE INTO title_ids(kind, value, title_id) VALUES(?,?,?)", [kind, String(value), titleId]);
}
