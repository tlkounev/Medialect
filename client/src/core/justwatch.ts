// JustWatch (unofficial GraphQL), port of app/sources/justwatch.py.
// Services in the user's order (priority), newest titles first. JustWatch returns at most 1999 titles per
// query, so each catalogue is walked in release-year windows per object type; a window that hits the cap is
// split in half. Finished windows are recorded, so an interrupted run continues where it stopped.
import { env, http, SourceError } from "./env";
import { DETAILS_QUERY, POPULAR_QUERY, PROVIDERS_QUERY } from "./jw_queries";
import { justwatchTech, langs, providerKey, providerName, qualityFromLabel } from "./quality";
import * as store from "./store";
import { jwProviders } from "./queries";
import type { SyncContext } from "./context";

export const GRAPHQL_URL = "https://apis.justwatch.com/graphql";
const IMAGES = "https://images.justwatch.com";
const DETAILS = "https://justwatch.com";
const SOURCE = "justwatch";
export const tuning = { PAGE: 50, CAP: 1999, RETRY_S: [3, 10, 20, 40], PARALLEL: 3 };
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

class SchemaError extends SourceError {}

// The offers are asked for the date JustWatch recorded them (dateCreated, the day the title came to the
// service); if JustWatch ever rejects the field, the catalogue is fetched without it as before.
const POPULAR_WITH_DATES = POPULAR_QUERY.replace("availableTo\n", "availableTo\n    dateCreated\n");
let offerDates = POPULAR_WITH_DATES !== POPULAR_QUERY;

async function gql(body: unknown): Promise<any> {
  let last: unknown;
  // mobile networks drop connections (cell handover, Wi-Fi <-> 5G, idle sockets): retry with growing pauses
  const pauses = tuning.RETRY_S;
  for (let attempt = 0; attempt <= pauses.length; attempt++) {
    try {
      const r = await http(GRAPHQL_URL, { json: body, headers: { Accept: "application/json" } });
      if (r.status === 429 || r.status >= 500) throw new SourceError(`JustWatch HTTP ${r.status}`);
      if (!r.ok) throw new SourceError(`JustWatch HTTP ${r.status}: ${r.text.slice(0, 200)}`);
      if (r.data?.errors) {
        const msg = JSON.stringify(r.data.errors).slice(0, 300);
        // a field JustWatch does not know: asking again changes nothing
        if (/Cannot query field|Unknown field|FieldUndefined/i.test(msg)) throw new SchemaError(`JustWatch: ${msg}`);
        throw new SourceError(`JustWatch: ${msg}`);
      }
      return r.data.data;
    } catch (e) {
      if (e instanceof SchemaError) throw e;
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
    out.push({ short_name: p.shortName, name: providerName(p.clearName), technical_name: p.technicalName || p.clearName,
      icon: p.icon ? IMAGES + p.icon : "", monetization_types: mt });
  }
  // short name (settings) -> provider key (catalogue), for ordering offers by the user's service order
  if (env.db) {
    const keys = await env.db.kvGet<Record<string, string>>("jw.provider_keys", {});
    for (const p of out) keys[p.short_name] = providerKey(p.technical_name || p.name);
    await env.db.kvSet("jw.provider_keys", keys);
    const icons = await env.db.kvGet<Record<string, string>>("jw.provider_icons", {});
    for (const p of out) if (p.icon) icons[providerKey(p.technical_name || p.name)] = p.icon;
    await env.db.kvSet("jw.provider_icons", icons);
  }
  return out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

export async function popularPage(country: string, language: string, count: number, offset: number, provider: string,
  lo: number, hi: number, otype: string): Promise<any[]> {
  const ask = (query: string) => gql({
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
    query,
  });
  let data;
  try { data = await ask(offerDates ? POPULAR_WITH_DATES : POPULAR_QUERY); }
  catch (e) {
    if (!(e instanceof SchemaError) || !offerDates) throw e;
    offerDates = false;                           // JustWatch does not know the field: carry on without dates
    data = await ask(POPULAR_QUERY);
  }
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

async function storeEntry(ctx: SyncContext, node: any, selected: Map<string, string>): Promise<number> {
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
      source: SOURCE, provider: providerKey(pkg.technicalName || pkg.clearName), provider_name: providerName(pkg.clearName),
      kind: "stream", monetization: mon, quality: qualityFromLabel(o.presentationType),
      video: justwatchTech(o.videoTechnology, "video"), audio: justwatchTech(o.audioTechnology, "audio"),
      audio_langs: langs(o.audioLanguages), subtitle_langs: langs(o.subtitleLanguages), url: o.standardWebURL,
      extra: { jw_url: jwUrl, icon: pkg.icon ? IMAGES + pkg.icon : "" }, expires_on: o.availableTo ?? null,
      added_at: typeof o.dateCreated === "string" && o.dateCreated ? o.dateCreated.slice(0, 19) : null,
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
  return tid;
}

const withDates = (q: string) => (offerDates ? q.replace("availableTo\n", "availableTo\n    dateCreated\n") : q);
const VARS = { formatPoster: "JPG", formatOfferIcon: "PNG", profile: "S718", backdropProfile: "S1920", filter: { bestOnly: true } };

/** One JustWatch query that asks for the offers' dates when JustWatch knows the field. */
async function dated(operationName: string, query: string, variables: Record<string, unknown>): Promise<any> {
  try { return await gql({ operationName, variables, query: withDates(query) }); }
  catch (e) {
    if (!(e instanceof SchemaError) || !offerDates) throw e;
    offerDates = false;
    return gql({ operationName, variables, query });
  }
}

/** One title again: its JustWatch entry now (by its JustWatch id, else found by name), offers on the selected
 *  services added, changed and removed. */
export async function refreshTitle(title: store.RefreshTitle, ctx: SyncContext): Promise<void> {
  const s = ctx.settings;
  const selected = new Map(jwProviders(s.justwatch.providers).map((sn: string) => [sn, sn] as [string, string]));
  const locale = { country: s.country.toUpperCase(), language: s.language };
  let node: any = null;
  if (title.ids.jw) {
    try { node = (await dated("GetTitleNode", DETAILS_QUERY, { nodeId: title.ids.jw, ...VARS, ...locale }))?.node || null; }
    catch { node = null; }                          // an id JustWatch no longer knows: look the title up by name
  }
  if (!node) {
    const otype = title.type === "movie" ? "MOVIE" : "SHOW";
    for (const q of [...new Set([title.title, title.original_title].filter(Boolean) as string[])]) {
      const data = await dated("GetPopularTitles", POPULAR_QUERY, { first: 10, ...VARS, ...locale, offset: null,
        popularTitlesFilter: { searchQuery: q, includeTitlesWithoutUrl: true, objectTypes: [otype] } });
      const found = (data?.popularTitles?.edges || []).map((e: any) => e.node);
      node = found.find((n: any) => n.objectType === otype && store.sameWork(title, n.content?.title, null,
        n.content?.originalReleaseYear, { imdb: n.content?.externalIds?.imdbId,
          [otype === "MOVIE" ? "tmdb_movie" : "tmdb_tv"]: n.content?.externalIds?.tmdbId != null ? String(n.content.externalIds.tmdbId) : null })) || null;
      if (node) break;
    }
  }
  if (!node) { await store.removeStaleTitle(title.id, SOURCE, ctx.started); return; }   // no longer on JustWatch
  const tid = await storeEntry(ctx, node, selected);
  for (const t of new Set([tid, title.id])) await store.removeStaleTitle(t, SOURCE, ctx.started);
}

export async function sync(ctx: SyncContext): Promise<void> {
  const cfg = ctx.settings.justwatch;
  const wanted = jwProviders(cfg.providers);   // iVysílání and own servers have their own sources
  if (!wanted.length) { ctx.note("Nejsou vybrané žádné služby."); return; }
  const delayMs = Math.max(0, Number(cfg.request_delay_s ?? 0.5)) * 1000;
  const names = new Map((await listProviders(ctx.settings.country)).map((p) => [p.short_name, p.name]));
  const selected = new Map(wanted.map((sn) => [sn, names.get(sn) || sn]));
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

  // several services are fetched at the same time (each with its own pause between requests); they start
  // in the user's order, so the most important ones are complete first
  const seen = new Set<string>();
  let failed = 0;
  const list = [...selected];
  const share = new Map<string, number>();          // service -> its finished share (0–1)
  const doing = new Map<string, string>();          // service -> what it fetches right now
  const report = () => ctx.progress([...doing.values()].join(" · "),
    [...share.values()].reduce((a, b) => a + b, 0) / list.length);
  async function one(provider: string, pname: string): Promise<void> {
    let failures = 0;
    share.set(provider, 0);
    for (const [tIdx, otype] of ["MOVIE", "SHOW"].entries()) {
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
        doing.set(provider, `${pname}: ${kind} ${lo}–${hi}`);
        share.set(provider, (tIdx + done) / 2);
        report();
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
    share.set(provider, 1);
    doing.delete(provider);
    report();
    ctx.note(`${pname}: hotovo.`);
  }
  let next = 0, error: unknown = null;
  const worker = async () => {
    while (next < list.length && !error) {
      const [provider, pname] = list[next++];
      try { await one(provider, pname); } catch (e) { error ??= e; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(tuning.PARALLEL, list.length)) }, worker));
  if (error) throw error;
  ctx.note(`Celkem ${seen.size} titulů.`);
  if (failed) { ctx.note(`Nestaženo ${failed} částí, doplní se automaticky.`); return; }
  await env.db.run("DELETE FROM kv WHERE key=?", [RESUME_KEY]);
  // offers not seen since the run began (including its interrupted part) have left the service
  if (!ctx.partial) ctx.note(`Odstraněno ${await store.removeStale(SOURCE, st.started)} neaktuálních nabídek.`);
}
