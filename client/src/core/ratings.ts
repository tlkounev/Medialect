// Ratings: IMDb dataset, TMDB, TVmaze, OMDb, MDBList, ČSFD (opt-in). Port of app/ratings.py.
import { env, http, SourceError, userAgent } from "./env";
import { now } from "./db";
import { norm } from "./quality";
import * as store from "./store";
import { rankSql } from "./queries";
import { SyncContext } from "./context";
import * as settingsMod from "./settings";

export const urls = {
  IMDB_RATINGS: "https://datasets.imdbws.com/title.ratings.tsv.gz",
  CSFD: "https://www.csfd.cz",
  TMDB: "https://api.themoviedb.org/3",
  TVMAZE: "https://api.tvmaze.com",
  OMDB: "https://www.omdbapi.com/",
  MDBLIST: "https://api.mdblist.com",
};
export const pauses = { CSFD_MS: 1500, TMDB_MS: 150, TVMAZE_MS: 600, OMDB_MS: 250, MDBLIST_MS: 200 };
const IMDB_MAX_AGE_S = 20 * 3600;


// --- IMDb (official non-commercial dataset; each device downloads it for its own user) ------
export async function imdbDataset(ctx: SyncContext, force = false): Promise<void> {
  const rows = await env.db.all("SELECT value, title_id FROM title_ids WHERE kind='imdb'");
  const wanted = new Map<string, number[]>();
  for (const r of rows) (wanted.get(r.value) || wanted.set(r.value, []).get(r.value)!).push(r.title_id);
  if (!wanted.size) return;
  const last = await env.db.kvGet<number>("imdb.applied_at", 0);
  // the dataset is a few MB, so it is downloaded at most once a day; until the next download,
  // newly added titles keep the IMDb score JustWatch provided
  if (!force && now() - last < IMDB_MAX_AGE_S) return;
  ctx.progress("IMDb: stahuji dataset", 0);
  let r: Response;
  try { r = await env.fetch(urls.IMDB_RATINGS, { headers: { "User-Agent": userAgent() } }); }
  catch (e) { throw new SourceError(`IMDb: ${(e as Error).message}`); }
  if (!r.ok || !r.body) throw new SourceError(`IMDb dataset HTTP ${r.status}`);
  ctx.progress(`IMDb: přiřazuji hodnocení (${wanted.size} titulů)`, 0.5);
  const reader = r.body.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream()).getReader();
  let buf = "", found = 0, header = true;
  const t = now();
  const apply = async (line: string) => {
    if (header) { header = false; return; }
    const tab = line.indexOf("\t");
    const tconst = line.slice(0, tab);
    const tids = wanted.get(tconst);
    if (!tids) return;
    const [avgS, votesS] = line.slice(tab + 1).split("\t");
    const avg = Number(avgS), votes = Number(votesS);
    for (const tid of tids) {
      await env.db.run(`INSERT INTO ratings(title_id, source, value, display, votes, url, updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(title_id, source) DO UPDATE SET value=excluded.value, display=excluded.display, votes=excluded.votes,
        url=excluded.url, updated_at=excluded.updated_at`,
        [tid, "imdb", avg * 10, avg.toFixed(1), votes, `https://www.imdb.com/title/${tconst}/`, t]);
    }
    found++;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) { await apply(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    if (done) break;
  }
  if (buf.trim()) await apply(buf);
  await env.db.kvSet("imdb.applied_at", now());
  ctx.items += found;
  ctx.note(`IMDb: ${found} hodnocení z ${wanted.size} titulů s IMDb ID.`);
}

// --- titles due for a per-title rating source ------------------------------------------------
/** only: the refresh button rates just that title. */
async function due(source: string, refreshDays: number, kinds: string[], ttype?: string, only?: number | null) {
  const refresh = now() - refreshDays * 86400;
  let sql = `SELECT t.id, t.type,
      (SELECT value FROM title_ids i WHERE i.title_id=t.id AND i.kind='imdb') AS imdb,
      (SELECT value FROM title_ids i WHERE i.title_id=t.id AND i.kind='tvdb') AS tvdb,
      (SELECT value FROM title_ids i WHERE i.title_id=t.id AND i.kind='tmdb_movie') AS tmdb_movie,
      (SELECT value FROM title_ids i WHERE i.title_id=t.id AND i.kind='tmdb_tv') AS tmdb_tv
    FROM titles t LEFT JOIN ratings r ON r.title_id=t.id AND r.source=?
    WHERE EXISTS (SELECT 1 FROM availability a WHERE a.title_id=t.id)
      AND EXISTS (SELECT 1 FROM title_ids i WHERE i.title_id=t.id AND i.kind IN (${kinds.map(() => "?").join(",")}))
      AND (r.updated_at IS NULL OR r.updated_at < ?)`;
  const params: unknown[] = [source, ...kinds, refresh];
  if (ttype) { sql += " AND t.type=?"; params.push(ttype); }
  if (only) { sql += " AND t.id=?"; params.push(only); }
  const [rank, rankParams] = await rankSql();     // in the user's service order
  return env.db.all(sql + ` ORDER BY r.updated_at IS NOT NULL, ${rank}, r.updated_at, t.id`, [...params, ...rankParams]);
}

// --- TMDB ----------------------------------------------------------------------------------
export async function tmdb(ctx: SyncContext): Promise<void> {
  const cfg = ctx.settings.ratings;
  const key = cfg.tmdb_api_key;
  if (!key) return;
  const rows = await due("tmdb_api", Number(cfg.refresh_days), ["tmdb_movie", "tmdb_tv", "imdb"], undefined, ctx.only);
  const headers: Record<string, string> = key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {};
  const auth: Record<string, string> = key.startsWith("eyJ") ? {} : { api_key: key };
  for (const [i, row] of rows.entries()) {
    ctx.progress(`TMDB: ${i + 1}/${rows.length}`, (i + 1) / rows.length);
    const kind = row.type === "movie" ? "movie" : "tv";
    let id = kind === "movie" ? row.tmdb_movie : row.tmdb_tv;
    if (!id && row.imdb) {
      const r = await http(`${urls.TMDB}/find/${row.imdb}`, { params: { ...auth, external_source: "imdb_id" }, headers });
      if (r.status === 401) throw new SourceError("TMDB: neplatný API klíč.");
      const hits = r.ok ? (r.data?.[kind === "movie" ? "movie_results" : "tv_results"] || []) : [];
      if (hits.length) { id = String(hits[0].id); await store.addTitleId(row.id, `tmdb_${kind}`, id); }
    }
    if (!id) { await store.setRating(row.id, "tmdb_api", null, null); continue; }
    const r = await http(`${urls.TMDB}/${kind}/${id}`, { params: auth, headers });
    if (r.status === 401) throw new SourceError("TMDB: neplatný API klíč.");
    if (r.status === 429) { await env.sleep(10000); continue; }
    if (r.ok && r.data?.vote_average && r.data?.vote_count) {
      const avg = r.data.vote_average;
      await store.setRating(row.id, "tmdb", avg * 10, avg.toFixed(1), r.data.vote_count, `https://www.themoviedb.org/${kind}/${id}`);
      ctx.items++;
    }
    await store.setRating(row.id, "tmdb_api", null, null);   // marker: checked now
    await env.sleep(pauses.TMDB_MS);
  }
}

// --- TVmaze (free, no key, series only) ------------------------------------------------------
export async function tvmaze(ctx: SyncContext): Promise<void> {
  const rows = await due("tvmaze", Number(ctx.settings.ratings.refresh_days), ["imdb", "tvdb"], "show", ctx.only);
  for (const [i, row] of rows.entries()) {
    ctx.progress(`TVmaze: ${i + 1}/${rows.length}`, (i + 1) / rows.length);
    let show: any = null;
    for (const [param, value] of [["imdb", row.imdb], ["thetvdb", row.tvdb]]) {
      if (!value) continue;
      let r = await http(`${urls.TVMAZE}/lookup/shows`, { params: { [param]: value } });
      if (r.status === 429) { await env.sleep(10000); r = await http(`${urls.TVMAZE}/lookup/shows`, { params: { [param]: value } }); }
      await env.sleep(pauses.TVMAZE_MS);              // TVmaze allows 20 calls per 10 s
      if (r.ok && r.data) { show = r.data; break; }
    }
    const avg = show?.rating?.average;
    if (avg) { await store.setRating(row.id, "tvmaze", avg * 10, avg.toFixed(1), null, show.url || null); ctx.items++; }
    else await store.setRating(row.id, "tvmaze", null, null);
  }
}

// --- OMDb (free key, 1000 requests/day): Rotten Tomatoes, Metacritic ---------------------------
export async function omdb(ctx: SyncContext): Promise<void> {
  const cfg = ctx.settings.ratings;
  if (!cfg.omdb_api_key) return;
  const rows = await due("omdb", Number(cfg.refresh_days), ["imdb"], undefined, ctx.only);
  const budget = Number(cfg.omdb_daily_budget);
  for (const [i, row] of rows.entries()) {
    ctx.progress(`OMDb: ${i + 1}/${rows.length}`, (i + 1) / rows.length);
    if (!(await env.db.budgetTake("omdb", budget))) {
      ctx.partial = true; ctx.note(`OMDb: denní limit ${budget} dotazů vyčerpán, pokračuje se zítra.`); return;
    }
    const r = await http(urls.OMDB, { params: { apikey: cfg.omdb_api_key, i: row.imdb } });
    if (r.status === 401) throw new SourceError("OMDb: neplatný API klíč nebo vyčerpaný limit.");
    const d = r.ok ? r.data || {} : {};
    if (d.Response === "False" && /limit/i.test(d.Error || "")) { ctx.partial = true; ctx.note("OMDb: limit API vyčerpán."); return; }
    for (const rt of d.Ratings || []) {
      const val: string = rt.Value || "";
      if (rt.Source === "Rotten Tomatoes" && val.endsWith("%")) {
        await store.setRating(row.id, "rottentomatoes", Number(val.slice(0, -1)), val.replace("%", " %"));
      } else if (rt.Source === "Metacritic" && val.includes("/")) {
        const score = val.split("/")[0];
        await store.setRating(row.id, "metacritic", Number(score), `${score}/100`);
      }
    }
    await store.setRating(row.id, "omdb", null, null);       // marker: checked now
    ctx.items++;
    await env.sleep(pauses.OMDB_MS);
  }
}

// --- MDBList ---------------------------------------------------------------------------------
const MDB_SOURCES: Record<string, string> = {
  tomatoes: "rottentomatoes", tomatoesaudience: "rottentomatoes_audience", popcorn: "rottentomatoes_audience",
  metacritic: "metacritic", metacriticuser: "metacritic_user", letterboxd: "letterboxd", trakt: "trakt",
  rogerebert: "rogerebert", myanimelist: "myanimelist",
};

export async function mdblist(ctx: SyncContext): Promise<void> {
  const cfg = ctx.settings.ratings;
  const key = cfg.mdblist_api_key;
  if (!key) return;
  const refresh = now() - Number(cfg.refresh_days) * 86400;
  const [rank, rankParams] = await rankSql();     // in the user's service order
  const rows = await env.db.all(`SELECT t.id, t.type, i.value AS imdb FROM titles t
      JOIN title_ids i ON i.title_id=t.id AND i.kind='imdb'
      LEFT JOIN ratings r ON r.title_id=t.id AND r.source='mdblist'
      WHERE EXISTS (SELECT 1 FROM availability a WHERE a.title_id=t.id) AND (r.updated_at IS NULL OR r.updated_at < ?)
        AND (? IS NULL OR t.id=?)
      ORDER BY r.updated_at IS NOT NULL, ${rank}, r.updated_at`, [refresh, ctx.only ?? null, ctx.only ?? null, ...rankParams]);
  const budget = Number(cfg.mdblist_daily_budget);
  for (const [i, row] of rows.entries()) {
    ctx.progress(`MDBList: ${i + 1}/${rows.length}`, (i + 1) / rows.length);
    if (!(await env.db.budgetTake("mdblist", budget))) { ctx.partial = true; ctx.note("MDBList: denní limit vyčerpán."); return; }
    const r = await http(`${urls.MDBLIST}/imdb/${row.type === "movie" ? "movie" : "show"}/${row.imdb}`, { params: { apikey: key } });
    if (r.status === 429) { ctx.partial = true; ctx.note("MDBList: limit API (429)."); return; }
    const data = r.ok && r.data && r.data.ratings != null ? r.data : null;
    if (!data) { await store.setRating(row.id, "mdblist", null, null); continue; }
    for (const rt of data.ratings || []) {
      const src = MDB_SOURCES[(rt.source || "").toLowerCase()];
      if (!src || rt.value === null || rt.value === undefined || rt.value === 0) continue;
      const display = String(rt.value) + (src.startsWith("rottentomatoes") || src.startsWith("metacritic") ? " %" : "");
      await store.setRating(row.id, src, rt.score != null ? Number(rt.score) : null, display, rt.votes ?? null, rt.url ?? null);
    }
    const s = data.score;
    await store.setRating(row.id, "mdblist", s ? Number(s) : null, s ? String(s) : null, null,
      `https://mdblist.com/?q=${encodeURIComponent(row.imdb)}`);
    ctx.items++;
    await env.sleep(pauses.MDBLIST_MS);
  }
}

// --- ČSFD (opt-in; no API, pages are read with an honest user agent) --------------------------
class CsfdBlocked extends SourceError {}
const ANUBIS = ['id="anubis_challenge"', "/.within.website/x/cmd/anubis/"];
const FILM_HREF = /href="\/film\/(\d+)-[^"/]*\/(?:prehled\/)?"/;
const YEAR = /\((\d{4})\)/;
const RATING = /class="film-rating-average[^"]*"[^>]*>\s*(\d{1,3})\s*%/;
const VOTES = /class="ratings-list[\s\S]*?class="counter"[^>]*>\s*\(?([\d\s ]+)\)?/;
const IMDB_LINK = /imdb\.com\/title\/(tt\d{5,10})/;
const NAME = /class="film-title-name"[^>]*>([^<]+)</;
const unescape = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

async function csfdGet(url: string, params?: Record<string, string>): Promise<{ page: string; url: string }> {
  const r = await http(url, { params, headers: { "Accept-Language": "cs,en;q=0.5" } });
  if ([403, 429, 503].includes(r.status) || ANUBIS.some((m) => r.text.includes(m))) {
    throw new CsfdBlocked(`ČSFD vrátil místo stránky anti-bot ověření (HTTP ${r.status}). Hodnocení se zkusí znovu při dalším běhu.`);
  }
  if (r.status !== 200) throw new SourceError(`ČSFD HTTP ${r.status}: ${url}`);
  return { page: r.text, url: r.url };
}

export function csfdSearchResults(page: string): [string, number | null, string][] {
  const out: [string, number | null, string][] = [];
  for (const block of page.split("<article").slice(1)) {
    const m = FILM_HREF.exec(block);
    if (!m || out.some((o) => o[0] === m[1])) continue;
    const y = YEAR.exec(block), n = NAME.exec(block);
    out.push([m[1], y ? Number(y[1]) : null, n ? unescape(n[1]).trim() : ""]);
  }
  return out;
}

/** A ČSFD id for a title, or null. `check` = a long-running series found by its start year: it is the
 *  title only if the years on its page reach the title's year (e.g. the 2026 "Scrubs" is series 10 of
 *  "Scrubs: Doktůrci (2001–2026)" on ČSFD). */
export async function csfdCandidates(title: string, year: number | null, type = "movie"): Promise<{ cid: string; check: boolean }[]> {
  const { page } = await csfdGet(`${urls.CSFD}/hledat/`, { q: title });
  const results = csfdSearchResults(page);
  const wanted = norm(title);
  const out: { cid: string; check: boolean }[] = [];
  const add = (cid: string, check: boolean) => { if (!out.some((x) => x.cid === cid)) out.push({ cid, check }); };
  if (year) {
    // the year must agree: exact (same name first), or ±1 with the same name; which one it is, the IMDb id
    // on its page decides (two films of one name and year)
    for (const [cid, y, name] of results) if (y === year && norm(name) === wanted) add(cid, false);
    for (const [cid, y] of results) if (y === year) add(cid, false);
    for (const [cid, y, name] of results) if (y && Math.abs(y - year) === 1 && norm(name) === wanted) add(cid, false);
    if (type === "show") {
      for (const [cid, y, name] of results) {
        const n = norm(name);
        if (y && y < year && (n === wanted || n.startsWith(`${wanted} `))) add(cid, true);
      }
    }
    return out;
  }
  for (const [cid, , name] of results) if (norm(name) === wanted) add(cid, false);
  return out;
}

export async function csfdFind(title: string, year: number | null, type = "movie"): Promise<{ cid: string; check: boolean } | null> {
  return (await csfdCandidates(title, year, type))[0] || null;
}

export const CSFD_REJECTED_KEY = "csfd.rejected";   // ["<ČSFD id>|<IMDb id>"]: that page is not the film with that IMDb id
async function csfdRejected(cid: string, imdb: string | null): Promise<boolean> {
  return !!imdb && (await env.db.kvGet<string[]>(CSFD_REJECTED_KEY, [])).includes(`${cid}|${imdb}`);
}

/** The years on a ČSFD page: "(2001–2026)" or "(2019– )" for series, the single year for films. */
export function csfdYears(page: string): [number, number | null] | null {
  // the header's origin line ("USA, (2001–2026), 73 h"), else the first range on the page
  const origin = /class="origin"[^>]*>([\s\S]{0,400})/.exec(page)?.[1] || page;
  const tag = "(?:<[^>]+>\\s*)*";
  const re = new RegExp(`\\(\\s*${tag}(\\d{4})\\s*${tag}[–-]\\s*${tag}(\\d{4})?`);
  const range = re.exec(origin) || re.exec(page);
  return range ? [Number(range[1]), range[2] ? Number(range[2]) : null] : null;
}

/** The year of a film on a ČSFD page (header's origin line: "USA, 2026, 172 min"). */
export function csfdFilmYear(page: string): number | null {
  const origin = /class="origin"[^>]*>([\s\S]{0,400})/.exec(page)?.[1];
  const m = origin ? /\b(1[89]\d\d|20\d\d)\b/.exec(origin.replace(/<[^>]+>/g, " ")) : null;
  return m ? Number(m[1]) : null;
}

async function csfdRating(cid: string): Promise<[number | null, number | null, string, string | null, [number, number | null] | null, number | null]> {
  const { page, url } = await csfdGet(`${urls.CSFD}/film/${cid}/prehled/`);
  if (!page.includes('class="film-rating-average') && !page.includes("film-header")) throw new SourceError(`ČSFD: neočekávaná stránka filmu ${cid}`);
  const m = RATING.exec(page), v = VOTES.exec(page), imdb = IMDB_LINK.exec(page);
  const digits = v ? v[1].replace(/\D/g, "") : "";
  return [m ? Number(m[1]) : null, digits ? Number(digits) : null, url, imdb ? imdb[1] : null, csfdYears(page), csfdFilmYear(page)];
}

/** Find and store the ČSFD rating of one title (a row of csfdQueue).
 *  The stored ČSFD id (from the library or an earlier search) is checked first, then the search results.
 *  The IMDb id on the ČSFD page decides between films of one name and year: a page with another film's IMDb
 *  id is never taken (and remembered as wrong); a page without any IMDb link is taken only if no candidate's
 *  page has the title's own IMDb id. At most 3 film pages per title. */
export async function csfdRateRow(row: any): Promise<void> {
  type Hit = { cid: string; check: boolean; stored: boolean; value: number | null; votes: number | null; url: string; imdb: string | null };
  const haveImdb: string | null = row.imdb_id || null;
  const cands: { cid: string; check: boolean; stored: boolean }[] = row.csfd_id ? [{ cid: row.csfd_id, check: false, stored: true }] : [];
  const noLink: { cid: string; stored: boolean }[] = [];
  /** That ČSFD page is not this title: never again (the library's ČSFD id included). */
  const reject = async (cid: string, stored: boolean) => {
    if (haveImdb) {
      const rejected = await env.db.kvGet<string[]>(CSFD_REJECTED_KEY, []);
      if (!rejected.includes(`${cid}|${haveImdb}`)) await env.db.kvSet(CSFD_REJECTED_KEY, [...rejected, `${cid}|${haveImdb}`].slice(-2000));
    }
    if (stored) await env.db.run("DELETE FROM title_ids WHERE title_id=? AND kind='csfd' AND value=?", [row.id, cid]);
  };
  let searched = false, tries = 0, n = 0;
  let hit: Hit | null = null, fallback: Hit | null = null;
  while (tries < 3) {
    if (n >= cands.length) {
      if (searched) break;
      searched = true;
      for (const name of [...new Set([row.title, row.original_title].filter(Boolean))]) {
        const found = await csfdCandidates(name, row.year, row.type);
        await env.sleep(pauses.CSFD_MS);
        if (found.length) { for (const f of found) if (!cands.some((x) => x.cid === f.cid)) cands.push({ ...f, stored: false }); break; }
      }
      continue;
    }
    const cand = cands[n++];
    if (await csfdRejected(cand.cid, haveImdb)) {
      if (cand.stored) await env.db.run("DELETE FROM title_ids WHERE title_id=? AND kind='csfd'", [row.id]);
      continue;
    }
    if (tries) await env.sleep(pauses.CSFD_MS);
    tries++;
    const [value, votes, url, imdb, years, filmYear] = await csfdRating(cand.cid);
    if (cand.check && !(years && years[0] <= row.year && (years[1] ?? 9999) >= row.year)) continue;   // a series of that name, not running that year
    if (row.type === "movie" && !years && filmYear && row.year && Math.abs(filmYear - row.year) > 1) {
      await reject(cand.cid, cand.stored);           // another film of that name (another year)
      continue;
    }
    const found: Hit = { ...cand, value, votes, url, imdb };
    if (haveImdb && imdb && imdb !== haveImdb) { await reject(cand.cid, cand.stored); continue; }
    if (haveImdb && !imdb) {                         // cannot tell: a page with the title's own IMDb id wins
      noLink.push({ cid: cand.cid, stored: cand.stored });
      fallback = fallback || found;
      continue;
    }
    hit = found;
    break;
  }
  // the page with the title's IMDb id won: the pages without a link are other films
  if (hit?.imdb) for (const x of noLink) await reject(x.cid, x.stored);
  hit = hit || fallback;
  if (!hit) { await store.setRating(row.id, "csfd", null, null); return; }
  const { cid, check, value, votes, url, imdb } = hit;
  if (!hit.stored) {
    await env.db.run("DELETE FROM title_ids WHERE title_id=? AND kind='csfd'", [row.id]);
    await store.addTitleId(row.id, "csfd", cid);
  }
  await store.setRating(row.id, "csfd", value, value !== null ? `${value} %` : null, votes, url);
  // the IMDb id of a whole long-running series is not attached to a later revival
  if (imdb && !check && !(await env.db.get("SELECT 1 FROM title_ids WHERE title_id=? AND kind='imdb'", [row.id]))) {
    await store.addTitleId(row.id, "imdb", imdb);
  }
}

/** The user asked for this title's ratings again: its ČSFD rating now (null = done, else why not). */
export async function csfdRefreshTitle(titleId: number): Promise<string | null> {
  const s = await settingsMod.load();
  if (!s.ratings.csfd) return null;
  const row = await env.db.get(`SELECT t.id, t.type, t.title, t.original_title, t.year,
      (SELECT value FROM title_ids i WHERE i.title_id=t.id AND i.kind='csfd') AS csfd_id,
      (SELECT value FROM title_ids i WHERE i.title_id=t.id AND i.kind='imdb') AS imdb_id
    FROM titles t WHERE t.id=?`, [titleId]);
  if (!row) return null;
  try { await csfdRateRow(row); } catch (e) {
    if (e instanceof CsfdBlocked || e instanceof SourceError) return e.message;
    return `ČSFD: ${(e as Error)?.message || e}`;   // network down: the card still comes back
  }
  return null;
}

/** The refresh button: every rating source for this one title now (what failed, for the user). The IMDb
 *  dataset is the whole IMDb (megabytes), so it waits for its daily run. */
export async function refreshTitle(titleId: number, settings: any): Promise<string[]> {
  const cfg = settings.ratings, notes: string[] = [];
  await env.db.run("UPDATE ratings SET updated_at=0 WHERE title_id=?", [titleId]);
  const ctx = new SyncContext("refresh", settings);
  ctx.only = titleId;
  for (const [name, fn, on] of [["MDBList", mdblist, cfg.mdblist_api_key], ["TMDB", tmdb, cfg.tmdb_api_key],
    ["TVmaze", tvmaze, cfg.tvmaze], ["OMDb", omdb, cfg.omdb_api_key]] as [string, (c: SyncContext) => Promise<void>, unknown][]) {
    if (!on) continue;
    try { await fn(ctx); }
    catch (e) { notes.push(e instanceof SourceError ? e.message : `${name}: ${(e as Error)?.message || e}`); }
  }
  const note = await csfdRefreshTitle(titleId);
  if (note) notes.push(note);
  return notes;
}

const FOCUS_KEY = "ratings.focus";   // titles the user has on screen right now: rated before the rest

/** Titles still to be rated: the ones on the user's screen first, then the user's service order. */
export async function csfdQueue(refresh: number): Promise<any[]> {
  const [rank, rankParams] = await rankSql();
  const focus = JSON.stringify((await env.db.kvGet<any>(FOCUS_KEY, {}))?.ids || []);
  return env.db.all(`SELECT t.id, t.type, t.title, t.original_title, t.year,
      (SELECT value FROM title_ids i WHERE i.title_id=t.id AND i.kind='csfd') AS csfd_id,
      (SELECT value FROM title_ids i WHERE i.title_id=t.id AND i.kind='imdb') AS imdb_id
    FROM titles t LEFT JOIN ratings r ON r.title_id=t.id AND r.source='csfd'
    WHERE EXISTS (SELECT 1 FROM availability a WHERE a.title_id=t.id) AND (r.updated_at IS NULL OR r.updated_at < ?)
    ORDER BY COALESCE((SELECT CAST(j.key AS INTEGER) FROM json_each(?) j WHERE j.value = t.id), 1000000),
      r.updated_at IS NOT NULL, ${rank}, csfd_id IS NULL, r.updated_at, t.id`, [refresh, focus, ...rankParams]);
}

export async function csfd(ctx: SyncContext): Promise<void> {
  const cfg = ctx.settings.ratings;
  if (!(await env.db.kvGet("migrate.csfd_series_v1", false))) {
    // revivals of long-running series were "not found" before: search those series again
    await env.db.run("DELETE FROM ratings WHERE source='csfd' AND value IS NULL AND url IS NULL AND title_id IN (SELECT id FROM titles WHERE type='show')");
    await env.db.kvSet("migrate.csfd_series_v1", true);
  }
  if (!(await env.db.kvGet("migrate.csfd_imdb_v2", false))) {
    // ČSFD pages are now checked against the title's IMDb id: rate again the titles where a film of the
    // same name could have been taken (the library's and titles sharing a name with another title)
    await env.db.run("DELETE FROM ratings WHERE source='csfd' AND title_id IN (SELECT a.title_id FROM availability a WHERE a.kind='library' UNION SELECT n.title_id FROM title_names n WHERE n.norm IN (SELECT norm FROM title_names GROUP BY norm HAVING COUNT(DISTINCT title_id) > 1))");
    await env.db.kvSet("migrate.csfd_imdb_v2", true);
  }
  const refresh = now() - Number(cfg.refresh_days) * 86400;
  let rows = await csfdQueue(refresh);
  if (!rows.length) return;
  // progress over the whole catalogue: a run that continues an interrupted one starts where it stopped
  const total = Number((await env.db.get("SELECT COUNT(*) AS n FROM titles t WHERE EXISTS (SELECT 1 FROM availability a WHERE a.title_id=t.id)"))!.n);
  const doneBefore = Math.max(0, total - rows.length);
  let focusV = (await env.db.kvGet<any>(FOCUS_KEY, {}))?.v;
  const budget = Number(cfg.csfd_daily_budget);
  let errors = 0;
  const seen = new Set<number>();
  for (let i = 0; rows.length; ) {
    // the user scrolled to other titles: those come next
    const v = (await env.db.kvGet<any>(FOCUS_KEY, {}))?.v;
    if (v !== focusV) {
      focusV = v;
      rows = (await csfdQueue(refresh)).filter((r) => !seen.has(r.id));
      if (!rows.length) break;
    }
    const row = rows.shift()!;
    seen.add(row.id);
    i++;
    ctx.progress(`ČSFD: ${doneBefore + i}/${total}`, (doneBefore + i) / Math.max(1, total));
    if (!(await env.db.budgetTake("csfd", budget))) { ctx.partial = true; ctx.note(`ČSFD: denní limit ${budget} titulů vyčerpán.`); return; }
    try {
      await csfdRateRow(row);
      ctx.items++;
      errors = 0;
    } catch (e) {
      if (e instanceof CsfdBlocked) { ctx.partial = true; ctx.note(e.message); return; }
      if (!(e instanceof SourceError)) throw e;
      errors++;
      ctx.note(e.message);
      if (errors >= 5) { ctx.partial = true; ctx.note("ČSFD: příliš mnoho chyb za sebou, běh přerušen."); return; }
    }
    await env.sleep(pauses.CSFD_MS);
  }
}

export async function sync(ctx: SyncContext): Promise<void> {
  const cfg = ctx.settings.ratings;
  const steps: [string, (c: SyncContext) => Promise<void>, unknown][] = [
    ["IMDb", (c) => imdbDataset(c), cfg.imdb_dataset], ["MDBList", mdblist, cfg.mdblist_api_key],
    ["TMDB", tmdb, cfg.tmdb_api_key], ["TVmaze", tvmaze, cfg.tvmaze], ["OMDb", omdb, cfg.omdb_api_key],
    ["ČSFD", csfd, cfg.csfd],
  ];
  const enabled = steps.filter(([, , on]) => on);
  for (const [k, [name, fn]] of enabled.entries()) {
    ctx.step(k, enabled.length);
    try { await fn(ctx); }
    catch (e) { ctx.partial = true; ctx.note(e instanceof SourceError ? e.message : `${name}: ${(e as Error)?.message || e}`); }
  }
}
