// Read side: catalogue browsing, facets, title hydration (port of app/queries.py).
import { env } from "./env";
import { QUALITY_ORDER, bestQuality, mergeTags, norm } from "./quality";

const RATING_ORDER = ["csfd", "imdb", "tmdb", "tvmaze", "rottentomatoes", "rottentomatoes_audience", "metacritic",
  "metacritic_user", "letterboxd", "trakt", "mdblist"];
const SOURCE_PRIORITY: Record<string, number> = { sa: 0, justwatch: 1 };

const j = (s: string | null): any[] => { try { return s ? JSON.parse(s) : []; } catch { return []; } };
const list = (v?: string | null) => (v || "").split(",").map((x) => x.trim()).filter(Boolean);
const ph = (n: number) => Array(n).fill("?").join(",");

/** Provider key -> position in the user's service order (settings), for sorting offers. */
export async function providerRank(): Promise<Map<string, number>> {
  const s = await env.db.kvGet<any>("settings", {});
  const keys = await env.db.kvGet<Record<string, string>>("jw.provider_keys", {});
  return new Map(((s?.justwatch?.providers || []) as string[]).map((sn, i) => [keys[sn] || sn, i]));
}

export async function hydrate(titleIds: number[]): Promise<any[]> {
  if (!titleIds.length) return [];
  const order = await providerRank();
  const db = env.db, p = ph(titleIds.length);
  const titles = new Map((await db.all(`SELECT * FROM titles WHERE id IN (${p})`, titleIds)).map((r) => [r.id, r]));
  const ids = new Map<number, Record<string, string>>();
  for (const r of await db.all(`SELECT * FROM title_ids WHERE title_id IN (${p})`, titleIds)) {
    (ids.get(r.title_id) || ids.set(r.title_id, {}).get(r.title_id)!)[r.kind] = r.value;
  }
  const ratings = new Map<number, any[]>();
  for (const r of await db.all(`SELECT * FROM ratings WHERE title_id IN (${p}) AND display IS NOT NULL`, titleIds)) {
    (ratings.get(r.title_id) || ratings.set(r.title_id, []).get(r.title_id)!)
      .push({ source: r.source, display: r.display, value: r.value, votes: r.votes, url: r.url });
  }
  const where = new Map<number, Map<string, any>>();
  for (const r of await db.all(`SELECT * FROM availability WHERE title_id IN (${p})`, titleIds)) {
    const groups = where.get(r.title_id) || where.set(r.title_id, new Map()).get(r.title_id)!;
    const key = `${r.provider}|${r.monetization}`;
    const offer = {
      provider: r.provider, provider_name: r.provider_name, kind: r.kind, monetization: r.monetization,
      quality: r.quality, video: j(r.video), audio: j(r.audio), audio_langs: j(r.audio_langs),
      subtitle_langs: j(r.subtitle_langs), url: r.url, expires_on: r.expires_on, added_at: r.added_at,
      sources: [r.source], extra: JSON.parse(r.extra || "{}"),
    };
    const cur = groups.get(key);
    if (!cur) { groups.set(key, offer); continue; }
    const better = (SOURCE_PRIORITY[r.source] ?? 9) < Math.min(...cur.sources.map((s: string) => SOURCE_PRIORITY[s] ?? 9));
    Object.assign(cur, {
      quality: bestQuality(cur.quality, offer.quality), video: mergeTags(cur.video, offer.video),
      audio: mergeTags(cur.audio, offer.audio), audio_langs: mergeTags(cur.audio_langs, offer.audio_langs),
      subtitle_langs: mergeTags(cur.subtitle_langs, offer.subtitle_langs), expires_on: cur.expires_on || offer.expires_on,
      added_at: [cur.added_at, offer.added_at].filter(Boolean).sort().pop() || null,
      sources: [...cur.sources, ...offer.sources], extra: { ...cur.extra, ...offer.extra },
    });
    if (better && offer.url) cur.url = offer.url;
  }
  const out: any[] = [];
  for (const tid of titleIds) {
    const t = titles.get(tid);
    if (!t) continue;
    const rank = (s: string) => (RATING_ORDER.includes(s) ? RATING_ORDER.indexOf(s) : 99);
    const rs = (ratings.get(tid) || []).sort((a, b) => rank(a.source) - rank(b.source));
    const offers = [...(where.get(tid)?.values() || [])].sort((a, b) =>
      Number(a.kind !== "library") - Number(b.kind !== "library") ||
      (order.get(a.provider) ?? 999) - (order.get(b.provider) ?? 999) ||
      (a.provider_name || "").toLowerCase().localeCompare((b.provider_name || "").toLowerCase()));
    out.push({ id: tid, type: t.type, title: t.title, original_title: t.original_title, year: t.year, poster: t.poster,
      ids: ids.get(tid) || {}, ratings: rs, where: offers });
  }
  return out;
}

export interface CatalogQuery {
  provider?: string; type?: string; quality?: string; video?: string; audio?: string; lang?: string; sub?: string;
  sort?: string; order?: string; page?: number; page_size?: number; q?: string;
}

export async function catalog(f: CatalogQuery) {
  const cond: string[] = [], params: unknown[] = [];
  const nq = norm(f.q || "");
  const provs = list(f.provider);
  if (provs.length) { cond.push(`a.provider IN (${ph(provs.length)})`); params.push(...provs); }
  const quals = list(f.quality).filter((x) => x in QUALITY_ORDER);
  if (quals.length) { cond.push(`a.quality IN (${ph(quals.length)})`); params.push(...quals); }
  // several values in one filter = any of them (OR); different filters = all (AND), on the same offer
  for (const [col, val] of [["video", f.video], ["audio", f.audio], ["audio_langs", f.lang], ["subtitle_langs", f.sub]]) {
    const vals = list(val);
    if (vals.length) { cond.push("(" + vals.map(() => `a.${col} LIKE ?`).join(" OR ") + ")"); params.push(...vals.map((v) => `%"${v}"%`)); }
  }
  let where = `WHERE EXISTS (SELECT 1 FROM availability a WHERE a.title_id=t.id${cond.map((c) => ` AND ${c}`).join("")})`;
  const types = list(f.type).filter((x) => x === "movie" || x === "show");
  if (types.length === 1) { where += " AND t.type=?"; params.push(types[0]); }
  if (nq) { where += " AND EXISTS (SELECT 1 FROM title_names n WHERE n.title_id=t.id AND n.norm LIKE ?)"; params.push(`%${nq}%`); }
  const dir = f.order === "asc" ? "ASC" : "DESC";
  const sort = f.sort || "added";
  let orderSql: string, join = "", jparams: unknown[] = [];
  if (sort === "title") orderSql = `t.title COLLATE NOCASE ${dir}`;
  else if (sort === "year") orderSql = `t.year IS NULL, t.year ${dir}, t.title COLLATE NOCASE`;
  else if (sort === "added") {
    const pc = provs.length ? ` AND a.provider IN (${ph(provs.length)})` : "";
    join = `LEFT JOIN (SELECT a.title_id, MAX(a.added_at) AS added FROM availability a WHERE a.added_at IS NOT NULL${pc} ` +
      "GROUP BY a.title_id) ad ON ad.title_id=t.id";
    jparams = [...provs];
    orderSql = `ad.added IS NULL, ad.added ${dir}, t.year DESC`;
  } else {
    orderSql = `r.value IS NULL, r.value ${dir}, t.year DESC`;
    join = "LEFT JOIN ratings r ON r.title_id=t.id AND r.source=?";
    jparams = [sort];
  }
  let orderParams: unknown[] = [];
  if (nq) {
    orderSql = "(SELECT MAX(n.norm = ?) FROM title_names n WHERE n.title_id=t.id) DESC, " +
      "(SELECT MAX(n.norm LIKE ?) FROM title_names n WHERE n.title_id=t.id) DESC, " + orderSql;
    orderParams = [nq, `${nq}%`];
  }
  const total = (await env.db.get(`SELECT COUNT(*) AS n FROM titles t ${where}`, params))!.n;
  const page = Math.max(1, Number(f.page) || 1);
  const pageSize = Math.max(1, Math.min(Number(f.page_size) || 50, 200));
  const rows = await env.db.all(`SELECT t.id FROM titles t ${join} ${where} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
    [...jparams, ...params, ...orderParams, pageSize, (page - 1) * pageSize]);
  return { total, page, page_size: pageSize, items: await hydrate(rows.map((r) => r.id)) };
}

export async function providers() {
  return env.db.all("SELECT provider, MAX(provider_name) AS name, kind, COUNT(DISTINCT title_id) AS titles " +
    "FROM availability GROUP BY provider, kind ORDER BY kind DESC, name COLLATE NOCASE");
}

export async function stats() {
  const t = await env.db.get("SELECT COUNT(*) AS n FROM titles t WHERE EXISTS (SELECT 1 FROM availability a WHERE a.title_id=t.id)");
  const o = await env.db.get("SELECT COUNT(*) AS n FROM availability");
  const r = await env.db.get("SELECT COUNT(*) AS n FROM ratings WHERE display IS NOT NULL");
  return { titles: t!.n, offers: o!.n, ratings: r!.n };
}

export async function facets() {
  const tags = async (col: string) => (await env.db.all(
    `SELECT j.value AS v, COUNT(DISTINCT a.title_id) AS n FROM availability a, json_each(a.${col}) j ` +
    "WHERE j.value IS NOT NULL AND j.value != '' GROUP BY j.value ORDER BY n DESC")).map((r) => ({ value: r.v, titles: r.n }));
  const ratings = await env.db.all(
    "SELECT source, COUNT(*) AS n FROM ratings WHERE display IS NOT NULL GROUP BY source ORDER BY n DESC");
  const q = await env.db.all("SELECT quality AS v, COUNT(DISTINCT title_id) AS n FROM availability WHERE quality IS NOT NULL GROUP BY quality");
  const added = await env.db.get("SELECT COUNT(DISTINCT title_id) AS n FROM availability WHERE added_at IS NOT NULL");
  return {
    quality: q.map((r) => ({ value: r.v, titles: r.n })).sort((a, b) => (QUALITY_ORDER[b.value] || 0) - (QUALITY_ORDER[a.value] || 0)),
    with_added_date: added!.n,
    audio_langs: await tags("audio_langs"), subtitle_langs: await tags("subtitle_langs"),
    video: await tags("video"), audio: await tags("audio"),
    ratings: ratings.map((r) => ({ value: r.source, titles: r.n })),
  };
}
