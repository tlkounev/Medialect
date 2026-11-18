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
  /** id kinds this source knows better than our own lookups (e.g. the ČSFD id an Emby plugin assigned) */
  authoritative?: string[];
  /** the user's own library: its IMDb/TMDB/TVDB ids win over a catalogue entry that gave them to another work */
  library?: boolean;
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

const OWN_KINDS = ["jw", "sa", "ct"];
// ids that name exactly one work: a title never holds two different values of one of these kinds
const STRONG_KINDS = ["imdb", "tmdb_movie", "tmdb_tv", "tvdb"];
const yearsClash = (a?: number | null, b?: number | null) => !!(a && b && Math.abs(a - b) > 2);

/** Would merging these ids into the title give it two different values of one strong kind? */
async function conflicts(tid: number, ids: Record<string, string>): Promise<boolean> {
  const existing = new Map<string, Set<string>>();
  for (const r of await env.db.all("SELECT kind, value FROM title_ids WHERE title_id=?", [tid])) {
    if (!existing.has(r.kind)) existing.set(r.kind, new Set());
    existing.get(r.kind)!.add(r.value);
  }
  return Object.entries(ids).some(([k, v]) => STRONG_KINDS.includes(k) && existing.has(k) && !existing.get(k)!.has(v));
}

async function findTitle(info: TitleInfo, ids: Record<string, string>): Promise<number | null> {
  const db = env.db;
  // 1) exact external id match (own entry ids first); an id shared by works years apart is a data error
  for (const [kind, value] of Object.entries(ids).sort(([a], [b]) => Number(!OWN_KINDS.includes(a)) - Number(!OWN_KINDS.includes(b)))) {
    const row = await db.get("SELECT i.title_id, t.year FROM title_ids i JOIN titles t ON t.id=i.title_id WHERE i.kind=? AND i.value=?", [kind, value]);
    if (!row) continue;
    if (OWN_KINDS.includes(kind)) return row.title_id;
    // one shared id is not enough when the rest disagrees: two works of the same name must stay apart
    if (!yearsClash(row.year, info.year) && !(await conflicts(row.title_id, ids))) return row.title_id;
  }
  // 2) name + year + type, but never merge across conflicting ids
  const names = namesOf(info);
  if (!names.length || !info.year) return null;
  const cands = await db.all(
    `SELECT DISTINCT t.id FROM titles t JOIN title_names n ON n.title_id=t.id
     WHERE t.type=? AND t.year BETWEEN ? AND ? AND n.norm IN (${names.map(() => "?").join(",")}) ORDER BY ABS(t.year-?)`,
    [info.type, info.year - 1, info.year + 1, ...names, info.year]);
  for (const { id } of cands) if (!(await conflicts(id, ids))) return id;
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
    if (info.authoritative?.includes(kind)) {
      const old = (await db.all("SELECT value FROM title_ids WHERE title_id=? AND kind=?", [tid, kind])).map((r) => r.value);
      if (!(old.length === 1 && old[0] === value)) {
        await db.run("DELETE FROM title_ids WHERE title_id=? AND kind=? AND value!=?", [tid, kind, value]);
        await db.run("INSERT OR REPLACE INTO title_ids(kind, value, title_id) VALUES(?,?,?)", [kind, value, tid]);
        if (kind === "csfd") await db.run("DELETE FROM ratings WHERE title_id=? AND source='csfd'", [tid]);
      }
      continue;
    }
    if (info.library && STRONG_KINDS.includes(kind)) {
      // never from another library title: two servers that disagree must not take it from each other on every run
      const owner = await db.get("SELECT i.title_id FROM title_ids i WHERE i.kind=? AND i.value=? AND NOT EXISTS " +
        "(SELECT 1 FROM availability a WHERE a.title_id=i.title_id AND a.kind='library')", [kind, value]);
      if (owner && owner.title_id !== tid) {
        await db.run("UPDATE title_ids SET title_id=? WHERE kind=? AND value=?", [tid, kind, value]);
        await db.run("DELETE FROM ratings WHERE title_id=?", [owner.title_id]);
        continue;
      }
    }
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

/** Titles holding two values of one strong id kind mix two works: drop them, the full sync recreates them. */
export async function repairMixedTitles(): Promise<number> {
  const rows = await env.db.all(
    `SELECT DISTINCT title_id FROM title_ids WHERE kind IN (${STRONG_KINDS.map(() => "?").join(",")}) GROUP BY title_id, kind HAVING COUNT(*) > 1`,
    STRONG_KINDS);
  for (const { title_id } of rows)
    for (const [table, col] of [["availability", "title_id"], ["ratings", "title_id"], ["title_ids", "title_id"], ["title_names", "title_id"], ["titles", "id"]])
      await env.db.run(`DELETE FROM ${table} WHERE ${col}=?`, [title_id]);
  return rows.length;
}
