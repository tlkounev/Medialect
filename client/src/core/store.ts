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

/** Has the ČSFD rating found this ČSFD page to be another film than the title (other IMDb id)? */
async function csfdRejected(tid: number, csfdId: string): Promise<boolean> {
  const imdbs = (await env.db.all("SELECT value FROM title_ids WHERE title_id=? AND kind='imdb'", [tid])).map((r) => r.value);
  if (!imdbs.length) return false;
  const rejected = await env.db.kvGet<string[]>("csfd.rejected", []);
  return imdbs.some((i) => rejected.includes(`${csfdId}|${i}`));
}

/** The strong kinds in which merging these ids into the title would give it two different values. */
async function conflictKinds(tid: number, ids: Record<string, string>): Promise<string[]> {
  const existing = new Map<string, Set<string>>();
  for (const r of await env.db.all("SELECT kind, value FROM title_ids WHERE title_id=?", [tid])) {
    if (!existing.has(r.kind)) existing.set(r.kind, new Set());
    existing.get(r.kind)!.add(r.value);
  }
  return Object.entries(ids).filter(([k, v]) => STRONG_KINDS.includes(k) && existing.has(k) && !existing.get(k)!.has(v)).map(([k]) => k);
}
const conflicts = async (tid: number, ids: Record<string, string>) => (await conflictKinds(tid, ids)).length > 0;

async function findTitle(info: TitleInfo, ids: Record<string, string>): Promise<number | null> {
  const db = env.db;
  // 1) exact external id match (own entry ids first); an id shared by works years apart is a data error
  for (const [kind, value] of Object.entries(ids).sort(([a], [b]) => Number(!OWN_KINDS.includes(a)) - Number(!OWN_KINDS.includes(b)))) {
    const row = await db.get("SELECT i.title_id, t.year FROM title_ids i JOIN titles t ON t.id=i.title_id WHERE i.kind=? AND i.value=?", [kind, value]);
    if (!row) continue;
    if (OWN_KINDS.includes(kind)) {
      // a catalogue entry joined to a title of another work (different IMDb id, e.g. a library film of
      // the same name merged by name earlier): it leaves that title, with the ratings it brought
      if (!(await conflictKinds(row.title_id, ids)).includes("imdb")) return row.title_id;
      await db.run("DELETE FROM title_ids WHERE kind=? AND value=?", [kind, value]);
      await db.run("DELETE FROM ratings WHERE title_id=? AND source!='csfd'", [row.title_id]);
      continue;
    }
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
  // 3) the user's own library and a streaming catalogue often disagree in one id (e.g. TMDB) for the same
  // series: the same name, type and year (±1) on one library and one catalogue title is the same work
  // (only one id may disagree, and never the IMDb id: that one tells two films of the same name apart)
  for (const { id } of cands) {
    if ((await hasLibrary(id)) === !!info.library) continue;
    const clash = await conflictKinds(id, ids);
    if (clash.length <= 1 && !clash.includes("imdb")) return id;
  }
  return null;
}

const hasLibrary = async (tid: number) => !!(await env.db.get("SELECT 1 AS x FROM availability WHERE title_id=? AND kind='library' LIMIT 1", [tid]));
const strongValue = async (tid: number, kind: string): Promise<string | null> =>
  (await env.db.get("SELECT value FROM title_ids WHERE title_id=? AND kind=? LIMIT 1", [tid, kind]))?.value ?? null;

// sources run at the same time: finding a title and creating it must not interleave (no duplicates)
let titleLock: Promise<unknown> = Promise.resolve();
export function upsertTitle(info: TitleInfo): Promise<number> {
  const p = titleLock.then(() => upsertTitleNow(info), () => upsertTitleNow(info));
  titleLock = p.catch(() => undefined);
  return p;
}

async function upsertTitleNow(info: TitleInfo): Promise<number> {
  const db = env.db;
  const ids = cleanIds(info);
  const t = now();
  let tid = await findTitle(info, ids);
  if (tid === null) {
    tid = (await db.run("INSERT INTO titles(type, title, original_title, year, poster, created_at, updated_at) VALUES(?,?,?,?,?,?,?)",
      [info.type, info.title, info.original_title, info.year, info.poster, t, t])).lastId;
  } else {
    // the poster of the user's own library wins (it is the one the user chose, and stays current)
    const posterSql = info.library ? "poster=COALESCE(?, poster)" : "poster=COALESCE(poster, ?)";
    await db.run("UPDATE titles SET original_title=COALESCE(original_title, ?), year=COALESCE(year, ?), " +
      `${posterSql}, updated_at=? WHERE id=?`, [info.original_title, info.year, info.poster, t, tid]);
  }
  for (const [kind, value] of Object.entries(ids)) {
    if (info.authoritative?.includes(kind)) {
      const old = (await db.all("SELECT value FROM title_ids WHERE title_id=? AND kind=?", [tid, kind])).map((r) => r.value);
      const same = old.length === 1 && old[0] === value;
      // the ratings found that ČSFD page to be another film (other IMDb id): it does not replace the one found
      if (kind === "csfd" && !same && (await csfdRejected(tid, value))) continue;
      if (!same) {
        await db.run("DELETE FROM title_ids WHERE title_id=? AND kind=? AND value!=?", [tid, kind, value]);
        await db.run("INSERT OR REPLACE INTO title_ids(kind, value, title_id) VALUES(?,?,?)", [kind, value, tid]);
        if (kind === "csfd") await db.run("DELETE FROM ratings WHERE title_id=? AND source='csfd'", [tid]);
      }
      continue;
    }
    if (STRONG_KINDS.includes(kind)) {
      const have = await strongValue(tid, kind);
      if (have !== null && have !== value) {
        // one work has one value of a strong id: the library's own id replaces a catalogue's (ratings
        // derived from the old one are fetched again), a catalogue's never replaces one
        if (!info.library) continue;
        await db.run("DELETE FROM title_ids WHERE title_id=? AND kind=?", [tid, kind]);
        await db.run("DELETE FROM ratings WHERE title_id=? AND source!='csfd'", [tid]);
      }
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

/** One title refreshed from one source: its offers that source no longer lists. */
export async function removeStaleTitle(titleId: number, source: string, before: number): Promise<number> {
  return (await env.db.run("DELETE FROM availability WHERE title_id=? AND source=? AND seen_at<?", [titleId, source, before])).changes;
}

/** The title being refreshed: { id, type, title, original_title, year, ids, offers }. */
export interface RefreshTitle {
  id: number; type: string; title: string; original_title: string | null; year: number | null;
  ids: Record<string, string>; offers: { source: string; url: string | null; extra: Record<string, any> }[];
}

/** Is a source's item (name, year, ids) the title being refreshed? A shared strong id decides; without one,
 *  the name and the year (±1) must agree. */
export function sameWork(title: RefreshTitle, name: string | null | undefined, original: string | null | undefined,
  year: number | null | undefined, ids: Record<string, string | null | undefined>): boolean {
  const shared = STRONG_KINDS.filter((k) => ids[k] && title.ids[k]);
  if (shared.length) return shared.every((k) => String(ids[k]) === String(title.ids[k]));
  const names = new Set([title.title, title.original_title].filter(Boolean).map((x) => norm(x)));
  if (![name, original].filter(Boolean).some((x) => names.has(norm(x)))) return false;
  return !(year && title.year && Math.abs(Number(year) - Number(title.year)) > 1);
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

/** Merges a catalogue title into the library title of the same work (same name, type, year ±1) that earlier
 *  runs kept apart because one id disagreed. Returns how many titles were merged. */
export function mergeLibraryTwins(): Promise<number> {
  const p = titleLock.then(mergeTwinsNow, mergeTwinsNow);
  titleLock = p.catch(() => undefined);
  return p;
}
async function mergeTwinsNow(): Promise<number> {
  const db = env.db;
  const rows = await db.all(`SELECT DISTINCT a.title_id AS lib, b.title_id AS cat
    FROM title_names a JOIN title_names b ON b.norm=a.norm AND b.title_id!=a.title_id
    JOIN titles l ON l.id=a.title_id JOIN titles c ON c.id=b.title_id
    WHERE l.type=c.type AND l.year IS NOT NULL AND c.year IS NOT NULL AND ABS(l.year-c.year) <= 1
      AND EXISTS (SELECT 1 FROM availability x WHERE x.title_id=l.id AND x.kind='library')
      AND NOT EXISTS (SELECT 1 FROM availability x WHERE x.title_id=c.id AND x.kind='library')
    ORDER BY a.title_id, b.title_id`);
  let merged = 0;
  for (const { lib, cat } of rows) {
    if (!(await db.get("SELECT 1 AS x FROM titles WHERE id=?", [cat]))) continue;   // already merged elsewhere
    for (const { kind, value } of await db.all("SELECT kind, value FROM title_ids WHERE title_id=?", [cat])) {
      const have = STRONG_KINDS.includes(kind) ? await strongValue(lib, kind) : null;
      if (have !== null && have !== value) await db.run("DELETE FROM title_ids WHERE kind=? AND value=?", [kind, value]);
      else await db.run("UPDATE OR IGNORE title_ids SET title_id=? WHERE kind=? AND value=?", [lib, kind, value]);
    }
    for (const table of ["availability", "title_names", "ratings"]) {
      await db.run(`UPDATE OR IGNORE ${table} SET title_id=? WHERE title_id=?`, [lib, cat]);
      await db.run(`DELETE FROM ${table} WHERE title_id=?`, [cat]);
    }
    await db.run("DELETE FROM title_ids WHERE title_id=?", [cat]);
    await db.run("UPDATE titles SET poster=COALESCE(poster, (SELECT poster FROM titles WHERE id=?)) WHERE id=?", [cat, lib]);
    await db.run("DELETE FROM titles WHERE id=?", [cat]);
    merged++;
  }
  return merged;
}
