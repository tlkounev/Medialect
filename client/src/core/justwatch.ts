// JustWatch (unofficial GraphQL), port of app/sources/justwatch.py.
// Services in the user's order (priority), newest titles first. JustWatch returns at most 1999 titles per
// query, so each catalogue is walked in release-year windows per object type; a window that hits the cap is
// split in half. Finished windows are recorded, so an interrupted run continues where it stopped.
import { env, http, SourceError } from "./env";
import { POPULAR_QUERY, PROVIDERS_QUERY } from "./jw_queries";
import { justwatchTech, langs, providerKey, qualityFromLabel } from "./quality";
import * as store from "./store";
import type { SyncContext } from "./context";

export const GRAPHQL_URL = "https://apis.justwatch.com/graphql";
const IMAGES = "https://images.justwatch.com";
const DETAILS = "https://justwatch.com";
const SOURCE = "justwatch";
export const tuning = { PAGE: 50, CAP: 1999, RETRY_S: [3, 10, 20, 40] };
const KEEP: Record<string, string> = { FLATRATE: "flatrate", FREE: "free", ADS: "ads", FAST: "free" };

const RESUME_KEY = "jw.resume";
const RESUME_MAX_AGE_S = 48 * 3600;      // an older unfinished run starts again (its data would be stale)
const MAX_FAILED_WINDOWS = 3;            // this many unreachable windows in a row: the network is gone, stop

interface ResumeState { scope: string; started: number; done: string[]; split: string[] }

/** Newest first: the titles people look for arrive first. */
function windows(): [number, number][] {
  const year = new Date().getFullYear();
  const w: [number, number][] = [];
  for (let y = year + 2; y >= 2024; y--) w.push([y, y]);
  return w.concat([[2022, 2023], [2019, 2021], [2015, 2018], [2010, 2014], [2000, 2009], [1990, 1999], [1970, 1989], [1900, 1969]]);
}

/** The checkpoint of an unfinished run, if it can still be continued. */
export async function resumePending(): Promise<ResumeState | null> {
  const s = await env.db.kvGet<ResumeState | null>(RESUME_KEY, null);
  return s && Date.now() / 1000 - s.started <= RESUME_MAX_AGE_S ? s : null;
}

async function gql(body: unknown): Promise<any> {
  let last: unknown;
  // mobile networks drop connections (cell handover, Wi-Fi <-> 5G, idle sockets): retry with growing pauses
  const pauses = tuning.RETRY_S;
  for (let attempt = 0; attempt <= pauses.length; attempt++) {
    try {
      const r = await http(GRAPHQL_URL, { json: body, headers: { Accept: "application/json" } });
      if (r.status === 429 || r.status >= 500) throw new SourceError(`JustWatch HTTP ${r.status}`);
      if (!r.ok) throw new SourceError(`JustWatch HTTP ${r.status}: ${r.text.slice(0, 200)}`);
      if (r.data?.errors) throw new SourceError(`JustWatch: ${JSON.stringify(r.data.errors).slice(0, 300)}`);
      return r.data.data;
    } catch (e) {
      last = e;
      if (attempt < pauses.length) await env.sleep(pauses[attempt] * 1000);
    }
  }
  throw last instanceof SourceError ? last : new SourceError(String(last));
}

export interface ProviderInfo { short_name: string; name: string; technical_name: string; icon: string; monetization_types: string[] }

export async function listProviders(country: string): Promise<ProviderInfo[]> {
  const data = await gql({ operationName: "GetProviders", variables: { country: country.toUpperCase(), formatOfferIcon: "PNG" },
    query: PROVIDERS_QUERY });
  const out: ProviderInfo[] = [];
  for (const p of data.packages || []) {
    const mt = (p.monetizationTypes || []).map((m: string) => m.toUpperCase());
    if (!mt.some((m: string) => m in KEEP)) continue;
    out.push({ short_name: p.shortName, name: p.clearName, technical_name: p.technicalName,
      icon: p.icon ? IMAGES + p.icon : "", monetization_types: mt });
  }
  // short name (settings) -> provider key (catalogue), for ordering offers by the user's service order
  if (env.db) {
    const keys = await env.db.kvGet<Record<string, string>>("jw.provider_keys", {});
    for (const p of out) keys[p.short_name] = providerKey(p.technical_name || p.name);
    await env.db.kvSet("jw.provider_keys", keys);
  }
  return out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

export async function popularPage(country: string, language: string, count: number, offset: number, provider: string,
  lo: number, hi: number, otype: string): Promise<any[]> {
  const data = await gql({
    operationName: "GetPopularTitles",
    variables: {
      first: count,
      popularTitlesFilter: { packages: [provider], includeTitlesWithoutUrl: true, objectTypes: [otype],
        releaseYear: { min: lo, max: hi } },
      formatPoster: "JPG", formatOfferIcon: "PNG", profile: "S718", backdropProfile: "S1920",
      filter: { bestOnly: true },
      country: country.toUpperCase(), language,
      offset: offset || null,
    },
    query: POPULAR_QUERY,
  });
  return (data.popularTitles?.edges || []).map((e: any) => e.node);
}

async function fetchWindow(ctx: SyncContext, provider: string, otype: string, lo: number, hi: number, delayMs: number):
  Promise<[any[], boolean]> {
  const s = ctx.settings;
  const results: any[] = [];
  let offset = 0;
  for (;;) {
    const count = Math.min(tuning.PAGE, tuning.CAP - offset);
    if (count <= 0) return [results, true];
    const batch = await popularPage(s.country, s.language, count, offset, provider, lo, hi, otype);
    await env.sleep(delayMs);
    results.push(...batch);
    if (batch.length < count) return [results, false];
    offset += count;
  }
}

async function storeEntry(ctx: SyncContext, node: any, selected: Map<string, string>): Promise<void> {
  const c = node.content || {};
  const ttype = node.objectType === "MOVIE" ? "movie" : "show";
  const imdb = c.externalIds?.imdbId || null;
  const tmdb = c.externalIds?.tmdbId || null;
  const ids: Record<string, string | null> = { jw: node.id, imdb };
  if (tmdb) ids[ttype === "movie" ? "tmdb_movie" : "tmdb_tv"] = String(tmdb);
  const tid = await store.upsertTitle({ type: ttype, title: c.title, year: c.originalReleaseYear ?? null,
    poster: c.posterUrl ? IMAGES + c.posterUrl : null, ids });
  const jwUrl = c.fullPath ? DETAILS + c.fullPath : null;
  for (const o of node.offers || []) {
    const pkg = o?.package;
    if (!pkg || !selected.has(pkg.shortName)) continue;
    const mon = KEEP[(o.monetizationType || "").toUpperCase()];
    if (!mon) continue;
    await store.upsertOffer(tid, {
      source: SOURCE, provider: providerKey(pkg.technicalName || pkg.clearName), provider_name: pkg.clearName,
      kind: "stream", monetization: mon, quality: qualityFromLabel(o.presentationType),
      video: justwatchTech(o.videoTechnology, "video"), audio: justwatchTech(o.audioTechnology, "audio"),
      audio_langs: langs(o.audioLanguages), subtitle_langs: langs(o.subtitleLanguages), url: o.standardWebURL,
      extra: { jw_url: jwUrl, icon: pkg.icon ? IMAGES + pkg.icon : "" }, expires_on: o.availableTo ?? null,
    }, ctx.started);
  }
  const sc = c.scoring;
  if (sc && ctx.settings.ratings.justwatch_scores) {
    // JustWatch scores only fill gaps; the IMDb dataset and the dedicated APIs win
    if (sc.imdbScore && imdb) {
      await store.setRating(tid, "imdb", sc.imdbScore * 10, sc.imdbScore.toFixed(1), sc.imdbVotes ?? null,
        `https://www.imdb.com/title/${imdb}/`, true);
    }
    if (sc.tmdbScore) await store.setRating(tid, "tmdb", sc.tmdbScore * 10, sc.tmdbScore.toFixed(1), null, null, true);
    if (sc.tomatoMeter !== null && sc.tomatoMeter !== undefined) {
      await store.setRating(tid, "rottentomatoes", sc.tomatoMeter, `${Math.round(sc.tomatoMeter)} %`, null, null, true);
    }
  }
  ctx.items++;
}

export async function sync(ctx: SyncContext): Promise<void> {
  const cfg = ctx.settings.justwatch;
  if (!cfg.providers?.length) { ctx.note("Nejsou vybrané žádné služby."); return; }
  const delayMs = Math.max(0, Number(cfg.request_delay_s ?? 0.5)) * 1000;
  const names = new Map((await listProviders(ctx.settings.country)).map((p) => [p.short_name, p.name]));
  const selected = new Map(cfg.providers.map((sn) => [sn, names.get(sn) || sn]));
  // continue an interrupted run of the same country and language; done windows are not fetched again
  const scope = `${ctx.settings.country}|${ctx.settings.language}`;
  let state = await resumePending();
  if (state && state.scope === scope) ctx.note(`Navazuji na přerušené stahování (${state.done.length} hotových částí).`);
  else { state = { scope, started: ctx.started, done: [], split: [] }; await env.db.kvSet(RESUME_KEY, state); }
  const st = state;
  const doneKeys = new Set(st.done), splitKeys = new Set(st.split);
  const mark = async (kind: "done" | "split", key: string) => {
    (kind === "done" ? doneKeys : splitKeys).add(key);
    st[kind].push(key);
    await env.db.kvSet(RESUME_KEY, st);
  };

  const seen = new Set<string>();
  let idx = 0, failures = 0, failed = 0;
  const slots = selected.size * 2; // every service × (films, series) is one equal share of the progress
  for (const [provider, pname] of selected) {   // the user's order = priority
    idx++;
    for (const [tIdx, otype] of ["MOVIE", "SHOW"].entries()) {
      const base = ((idx - 1) * 2 + tIdx) / slots;
      const wins = windows();
      const queue: [number, number, number][] = wins.map(([lo, hi]) => [lo, hi, 1 / wins.length]);
      let done = 0;
      while (queue.length) {
        const [lo, hi, w] = queue.shift()!;
        const key = `${provider}|${otype}|${lo}|${hi}`;
        if (doneKeys.has(key)) { done += w; continue; }
        if (splitKeys.has(key)) {
          const mid = Math.floor((lo + hi) / 2);
          queue.unshift([mid + 1, hi, w / 2], [lo, mid, w / 2]);
          continue;
        }
        const kind = otype === "MOVIE" ? "filmy" : "seriály";
        ctx.progress(`${pname} (${idx}/${selected.size}): ${kind} ${lo}–${hi}`, base + done / slots);
        let entries: any[], capped: boolean;
        try {
          [entries, capped] = await fetchWindow(ctx, provider, otype, lo, hi, delayMs);
          failures = 0;
        } catch (e) {
          // one unreachable window does not throw the run away: it stays unfinished and the next run
          // (started automatically) fetches only what is missing
          if (!(e instanceof SourceError)) throw e;
          failed++;
          if (++failures >= MAX_FAILED_WINDOWS) throw new SourceError(`${e.message} – stahování přerušeno, příště naváže.`);
          ctx.partial = true;
          ctx.note(`${pname} ${kind} ${lo}–${hi}: ${e.message}`);
          done += w;
          continue;
        }
        if (capped && hi > lo) {
          const mid = Math.floor((lo + hi) / 2);
          queue.unshift([mid + 1, hi, w / 2], [lo, mid, w / 2]);
          await mark("split", key);
          continue;
        }
        done += w;
        if (capped) { ctx.partial = true; ctx.note(`${pname} ${otype} ${lo}: víc než ${tuning.CAP} titulů, část chybí.`); }
        for (const e of entries) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          await storeEntry(ctx, e, selected);
        }
        await mark("done", key);
      }
    }
    ctx.note(`${pname}: hotovo (${seen.size} titulů celkem).`);
  }
  if (failed) { ctx.note(`Nestaženo ${failed} částí, doplní se automaticky.`); return; }
  await env.db.run("DELETE FROM kv WHERE key=?", [RESUME_KEY]);
  // offers not seen since the run began (including its interrupted part) have left the service
  if (!ctx.partial) ctx.note(`Odstraněno ${await store.removeStale(SOURCE, st.started)} neaktuálních nabídek.`);
}
