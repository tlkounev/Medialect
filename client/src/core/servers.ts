// Media servers: Emby, Jellyfin and Plex (port of app/sources/emby.py and app/sources/plex.py).
import type { SyncContext } from "./context";
import { env, http, SourceError } from "./env";
import { audioTags, bestQuality, langs, mergeTags, qualityFromDims, qualityFromLabel, videoTags } from "./quality";
import * as store from "./store";

const PAGE = 300;
const DETAIL_CONCURRENCY = 4;

interface Summary { quality: string | null; video: string[]; audio: string[]; audio_langs: string[]; subtitle_langs: string[] }
const empty = (): Summary => ({ quality: null, video: [], audio: [], audio_langs: [], subtitle_langs: [] });

function merge(a: Summary | undefined, b: Summary): Summary {
  if (!a) return b;
  return {
    quality: bestQuality(a.quality, b.quality), video: mergeTags(a.video, b.video), audio: mergeTags(a.audio, b.audio),
    audio_langs: mergeTags(a.audio_langs, b.audio_langs), subtitle_langs: mergeTags(a.subtitle_langs, b.subtitle_langs),
  };
}

const trimSlash = (u: string) => String(u || "").replace(/\/+$/, "");
/** Links and posters open on the phone: the public address when there is one, otherwise the internal one. */
function viewBase(srv: any): string {
  if (srv.link_mode === "internal") return trimSlash(srv.url);
  return trimSlash(srv.public_url) || trimSlash(srv.url);
}

async function get(base: string, path: string, headers: Record<string, string>, params?: Record<string, unknown>,
  timeoutMs = 120000) {
  let r;
  try {
    r = await http(base + path, { headers, params, timeoutMs });
  } catch (e) {
    // the HTTP client only says "error sending request": find out what is wrong with the address
    if (e instanceof SourceError && env.localNetwork && !(await env.localNetwork(false).catch(() => true))) {
      throw new SourceError("Aplikace nemá povolený přístup k místní síti, proto se k serveru doma nedostane. "
        + "Povol ho v Nastavení Androidu → Aplikace → Medialect → Oprávnění → Zařízení v okolí.");
    }
    const why = e instanceof SourceError && env.diagnose ? await env.diagnose(base).catch(() => null) : null;
    throw why ? new SourceError(why) : e;
  }
  if (r.status === 401 || r.status === 403) throw new SourceError(`${new URL(base).host}: neplatný API klíč / token (HTTP ${r.status}).`);
  if (!r.ok) throw new SourceError(`${new URL(base).host}: HTTP ${r.status}`);
  return r.data;
}

/**
 * The address the app talks to the server through: the internal one at home; away from home (mobile data)
 * the internal one does not answer, so the public one is used when it is filled in.
 */
async function reachable(srv: any, path: string, headers: Record<string, string>): Promise<[string, any]> {
  const internal = trimSlash(srv.url), pub = trimSlash(srv.public_url);
  try {
    return [internal, await get(internal, path, headers, undefined, pub && pub !== internal ? 6000 : 120000)];
  } catch (e) {
    if (!pub || pub === internal || !(e instanceof SourceError) || /HTTP 40[13]|token|klíč/.test(e.message)) throw e;
    try {
      return [pub, await get(pub, path, headers)];
    } catch (e2) {
      throw new SourceError(`${e.message} Veřejná adresa: ${(e2 as Error).message}`);
    }
  }
}

/** Library copies of one title (two files, another version with more audio tracks) add up. */
class Emitted<K> {
  private seen = new Map<number, [Summary, K, string | number | null]>();
  /** Returns the merged summary, the item to link to and the newest date; first = first copy of the title. */
  add(tid: number, summary: Summary, item: K, added: string | number | null): [Summary, K, any, boolean] {
    const prev = this.seen.get(tid);
    let main = item, s = summary, a = added;
    if (prev) {
      if (bestQuality(prev[0].quality, summary.quality) === prev[0].quality) main = prev[1];
      s = merge(prev[0], summary);
      a = [prev[2], added].filter((x) => x != null).sort().pop() ?? null;
    }
    this.seen.set(tid, [s, main, a]);
    return [s, main, a, !prev];
  }
}

// --- Emby / Jellyfin ------------------------------------------------------------
// MediaSourceCount: a film with several versions (two rips in one folder) is one item, and library listings
// return only its default version; with the count we know when to ask for all of them
const EMBY_FIELDS = "ProviderIds,MediaSources,MediaStreams,MediaSourceCount,OriginalTitle,ProductionYear,DateCreated";
const EMBY_EP_FIELDS = "MediaSources,MediaStreams,MediaSourceCount,DateCreated";

function embyHeaders(srv: any): Record<string, string> {
  return srv.type === "jellyfin"
    ? { Authorization: `MediaBrowser Token="${srv.token || ""}"`, Accept: "application/json" }
    : { "X-Emby-Token": srv.token || "", Accept: "application/json" };
}

function embyIds(providerIds: Record<string, string> | null | undefined, ttype: string): Record<string, string> {
  const pid: Record<string, string> = {};
  for (const [k, v] of Object.entries(providerIds || {})) if (v) pid[k.toLowerCase()] = String(v);
  const out: Record<string, string> = {};
  if (pid.imdb) out.imdb = pid.imdb;
  if (pid.tvdb) out.tvdb = pid.tvdb;
  if (pid.tmdb) out[ttype === "movie" ? "tmdb_movie" : "tmdb_tv"] = pid.tmdb;
  for (const [k, v] of Object.entries(pid)) if (k.includes("csfd")) out.csfd = v.split("-")[0];   // ČSFD plugin
  return out;
}

export function embySummary(item: any): Summary {
  const sources = item.MediaSources || [{ MediaStreams: item.MediaStreams || [] }];
  const s = empty();
  for (const src of sources) {
    for (const st of src.MediaStreams || []) {
      if (st.Type === "Video") {
        s.quality = bestQuality(s.quality, qualityFromDims(st.Width, st.Height));
        s.video = mergeTags(s.video, videoTags([st.VideoRange, st.VideoRangeType, st.ExtendedVideoType, st.ExtendedVideoSubType,
          st.ExtendedVideoSubTypeDescription, st.DisplayTitle, st.Title], st.Codec));
      } else if (st.Type === "Audio") {
        s.audio = mergeTags(s.audio, audioTags([st.Profile, st.DisplayTitle, st.Title], st.Codec, st.Channels));
        s.audio_langs = mergeTags(s.audio_langs, langs([st.Language]));
      } else if (st.Type === "Subtitle") {
        s.subtitle_langs = mergeTags(s.subtitle_langs, langs([st.Language]));
      }
    }
  }
  return s;
}

async function* embyItems(base: string, headers: Record<string, string>, userId: string, types: string, fields: string,
  extra: Record<string, unknown> = {}) {
  let start = 0;
  for (;;) {
    const data = await get(base, `/Users/${userId}/Items`, headers, {
      Recursive: "true", IncludeItemTypes: types, Fields: fields, StartIndex: start, Limit: PAGE,
      EnableImages: "true", ImageTypeLimit: 1, EnableUserData: "false", ...extra });
    const items = data?.Items || [];
    for (const it of items) yield it;
    start += items.length;
    if (!items.length || start >= (data?.TotalRecordCount || 0)) return;
  }
}

interface EmbyConn {
  flavor: "emby" | "jellyfin"; name: string; base: string; headers: Record<string, string>; source: string;
  provider: string; serverId: string; adminId: string; link: (id: string) => string; poster: (it: any) => string | null;
}

async function embyConnect(srv: any, ctx: SyncContext): Promise<EmbyConn> {
  const flavor = srv.type as "emby" | "jellyfin";
  const name = srv.name || (flavor === "emby" ? "Emby" : "Jellyfin");
  const view = viewBase(srv), headers = embyHeaders(srv);
  const [base, info] = await reachable(srv, "/System/Info", headers);
  if (base !== trimSlash(srv.url)) ctx.note(`${name}: interní adresa neodpovídá, synchronizuji přes veřejnou.`);
  const serverId = info?.Id;
  const users: any[] = (await get(base, "/Users", headers)) || [];
  const admin = users.find((u) => u?.Policy?.IsAdministrator) || users[0];
  if (!admin) throw new SourceError(`${name}: na serveru není žádný uživatel.`);
  return {
    flavor, name, base, headers, source: `${flavor}:${srv.id}`, provider: `${flavor}-${srv.id}`, serverId, adminId: admin.Id,
    link: (id) => flavor === "jellyfin"
      ? `${view}/web/#/details?id=${id}&serverId=${serverId}`
      : `${view}/web/index.html#!/item?id=${id}&serverId=${serverId}`,
    // images of Emby and Jellyfin need no token
    poster: (it) => it.ImageTags?.Primary ? `${view}/Items/${it.Id}/Images/Primary?maxHeight=360&tag=${it.ImageTags.Primary}` : null,
  };
}

/** emit(item, type, summary, added): one library item stored as a title with its offer. */
function embyEmitter(e: EmbyConn, ctx: SyncContext) {
  const emitted = new Emitted<any>();
  return async (item: any, ttype: "movie" | "show", summary: Summary, added?: string | null) => {
    const tid = await store.upsertTitle({ type: ttype, title: item.Name || "?", original_title: item.OriginalTitle,
      year: item.ProductionYear, poster: e.poster(item), ids: embyIds(item.ProviderIds, ttype), authoritative: ["csfd"], library: true });
    const dates = [item.DateCreated, added].filter(Boolean).sort();
    const [s, main, addedAt, first] = emitted.add(tid, summary, item, dates.length ? dates[dates.length - 1] : null);
    await store.upsertOffer(tid, { source: e.source, provider: e.provider, provider_name: e.name, kind: "library", monetization: "library",
      url: e.link(main.Id), extra: { item_id: main.Id, server_id: e.serverId, server_type: e.flavor },
      added_at: addedAt, ...s }, ctx.started);
    if (first) ctx.items++;
  };
}

/** The item with every version's tracks (the single-item endpoint returns all of them). */
async function embyAllVersions(e: EmbyConn, item: any) {
  if ((item.MediaSourceCount || 0) <= (item.MediaSources || []).length) return item;
  try {
    const full = await get(e.base, `/Users/${e.adminId}/Items/${item.Id}`, e.headers);
    return { ...item, MediaSources: full?.MediaSources || item.MediaSources };
  } catch { return item; }
}

async function embySync(srv: any, ctx: SyncContext): Promise<void> {
  const e = await embyConnect(srv, ctx);
  const { name, base, headers, adminId } = e;
  const emit = embyEmitter(e, ctx);
  ctx.progress(`${name}: filmy`, 0);
  for await (const it of embyItems(base, headers, adminId, "Movie", EMBY_FIELDS)) await emit(it, "movie", embySummary(await embyAllVersions(e, it)));
  const perSeries = new Map<string, Summary>(), newestEp = new Map<string, string>();
  ctx.progress(`${name}: kvalita epizod`, 1 / 3);
  let n = 0;
  for await (const raw of embyItems(base, headers, adminId, "Episode", EMBY_EP_FIELDS)) {
    const ep = await embyAllVersions(e, raw);
    if (++n % 500 === 0) ctx.progress(`${name}: kvalita epizod (${n})`);
    if (!ep.SeriesId) continue;
    perSeries.set(ep.SeriesId, merge(perSeries.get(ep.SeriesId), embySummary(ep)));
    if (ep.DateCreated && ep.DateCreated > (newestEp.get(ep.SeriesId) || "")) newestEp.set(ep.SeriesId, ep.DateCreated);
  }
  ctx.progress(`${name}: seriály`, 2 / 3);
  for await (const s of embyItems(base, headers, adminId, "Series", "ProviderIds,OriginalTitle,ProductionYear,DateCreated")) {
    await emit(s, "show", perSeries.get(s.Id) || embySummary({}), newestEp.get(s.Id));
  }
  const removed = await store.removeStale(e.source, ctx.started);
  ctx.note(`${name}: ${ctx.items} titulů, odstraněno ${removed}.`);
}

/** HTTP status of a GET (null = it answered 200 with this data). */
async function getOr404(base: string, path: string, headers: Record<string, string>, params?: Record<string, unknown>): Promise<any | null> {
  try { return await get(base, path, headers, params, 30000); }
  catch (err) {
    if (err instanceof SourceError && /HTTP (400|404)\b/.test(err.message)) return null;
    throw err;
  }
}

/** One title again: its library items now (quality, picture, ids), items of that name added since, and its
 *  offer gone when the item was deleted. */
async function embyRefresh(srv: any, title: store.RefreshTitle, ctx: SyncContext): Promise<void> {
  const e = await embyConnect(srv, ctx);
  const items = new Map<string, any>();
  for (const o of title.offers) {
    const iid = o.source === e.source ? o.extra?.item_id : null;
    if (!iid) continue;
    const it = await getOr404(e.base, `/Users/${e.adminId}/Items/${iid}`, e.headers, { Fields: EMBY_FIELDS });
    if (it?.Id) items.set(iid, it);
  }
  const kind = title.type === "movie" ? "Movie" : "Series";
  for (const q of [...new Set([title.title, title.original_title].filter(Boolean) as string[])]) {
    const data = await get(e.base, `/Users/${e.adminId}/Items`, e.headers, { Recursive: "true", SearchTerm: q,
      IncludeItemTypes: kind, Fields: EMBY_FIELDS, Limit: 20, EnableImages: "true", ImageTypeLimit: 1, EnableUserData: "false" }, 30000);
    for (const it of data?.Items || []) {
      if (!items.has(it.Id) && store.sameWork(title, it.Name, it.OriginalTitle, it.ProductionYear, embyIds(it.ProviderIds, title.type))) {
        items.set(it.Id, it);
      }
    }
  }
  const emit = embyEmitter(e, ctx);
  for (const it of items.values()) {
    if (it.Type === "Series" || title.type === "show") {
      let summary = embySummary({}), newest: string | null = null;
      for await (const ep of embyItems(e.base, e.headers, e.adminId, "Episode", EMBY_EP_FIELDS, { ParentId: it.Id })) {
        summary = merge(summary, embySummary(await embyAllVersions(e, ep)));
        if (ep.DateCreated && ep.DateCreated > (newest || "")) newest = ep.DateCreated;
      }
      await emit(it, "show", summary, newest);
    } else {
      await emit(it, "movie", embySummary(await embyAllVersions(e, it)));
    }
  }
  await store.removeStaleTitle(title.id, e.source, ctx.started);
}

// --- Plex -----------------------------------------------------------------------
function plexHeaders(srv: any): Record<string, string> {
  return { "X-Plex-Token": srv.token || "", Accept: "application/json", "X-Plex-Product": "Medialect",
    "X-Plex-Client-Identifier": `medialect-${srv.id}` };
}

function plexIds(guids: any[] | null | undefined, ttype: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const g of guids || []) {
    const id = String(g?.id || "");
    if (!id.includes("://")) continue;
    const [scheme, value] = id.split("://", 2);
    if (scheme === "imdb") out.imdb = value;
    else if (scheme === "tmdb") out[ttype === "movie" ? "tmdb_movie" : "tmdb_tv"] = value;
    else if (scheme === "tvdb") out.tvdb = value;
  }
  return out;
}

export function plexBasic(meta: any): Summary {
  const s = empty();
  for (const m of meta?.Media || []) {
    s.quality = bestQuality(s.quality, qualityFromLabel(m.videoResolution) || qualityFromDims(m.width, m.height));
    s.video = mergeTags(s.video, videoTags([], m.videoCodec));
    s.audio = mergeTags(s.audio, audioTags([m.audioProfile], m.audioCodec, m.audioChannels));
  }
  return s;
}

export function plexDetail(meta: any): Summary {
  const s = plexBasic(meta);
  for (const m of meta?.Media || []) for (const part of m.Part || []) for (const st of part.Stream || []) {
    if (st.streamType === 1) {
      const texts = [st.displayTitle, st.extendedDisplayTitle, st.colorTrc];
      if (st.DOVIPresent) texts.push("dolby vision");
      s.video = mergeTags(s.video, videoTags(texts, st.codec));
    } else if (st.streamType === 2) {
      s.audio = mergeTags(s.audio, audioTags([st.displayTitle, st.extendedDisplayTitle, st.title, st.profile], st.codec, st.channels));
      s.audio_langs = mergeTags(s.audio_langs, langs([st.languageCode || st.languageTag]));
    } else if (st.streamType === 3) {
      s.subtitle_langs = mergeTags(s.subtitle_langs, langs([st.languageCode || st.languageTag]));
    }
  }
  return s;
}

async function* plexAll(base: string, headers: Record<string, string>, section: string, type?: number) {
  let start = 0;
  for (;;) {
    const params: Record<string, unknown> = { includeGuids: 1, "X-Plex-Container-Start": start, "X-Plex-Container-Size": PAGE };
    if (type) params.type = type;
    const mc = (await get(base, `/library/sections/${section}/all`, headers, params))?.MediaContainer || {};
    const items = mc.Metadata || [];
    for (const it of items) yield it;
    start += items.length;
    if (!items.length || start >= (mc.totalSize ?? mc.size ?? 0)) return;
  }
}

/** Runs fn over items with at most `limit` requests at once; failures give undefined. */
async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i]); } catch { out[i] = undefined; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

interface PlexConn {
  name: string; base: string; headers: Record<string, string>; source: string; provider: string; machineId: string;
  detail: (key: string) => Promise<any>; link: (key: string) => string; poster: (m: any) => string | null;
}

async function plexConnect(srv: any, ctx: SyncContext): Promise<PlexConn> {
  const name = srv.name || "Plex";
  const headers = plexHeaders(srv);
  const pub = trimSlash(srv.public_url), view = viewBase(srv);
  const [base, ident] = await reachable(srv, "/identity", headers);
  if (base !== trimSlash(srv.url)) ctx.note(`${name}: interní adresa neodpovídá, synchronizuji přes veřejnou.`);
  const machineId = ident?.MediaContainer?.machineIdentifier;
  return {
    name, base, headers, source: `plex:${srv.id}`, provider: `plex-${srv.id}`, machineId,
    detail: async (key) => ((await get(base, `/library/metadata/${key}`, headers))?.MediaContainer?.Metadata || [])[0] || {},
    link: (key) => {
      const k = encodeURIComponent(`/library/metadata/${key}`);
      const root = srv.link_mode === "internal" ? base : pub;
      return root ? `${root}/web/index.html#!/server/${machineId}/details?key=${k}`
        : `https://app.plex.tv/desktop/#!/server/${machineId}/details?key=${k}`;
    },
    // Plex images need the token
    poster: (m) => m.thumb
      ? `${view}/photo/:/transcode?width=240&height=360&minSize=1&url=${encodeURIComponent(m.thumb)}&X-Plex-Token=${encodeURIComponent(srv.token || "")}`
      : null,
  };
}

const plexIso = (ts?: number) => (ts ? new Date(ts * 1000).toISOString().slice(0, 19) : null);

/** emit(meta, type, summary, added): one library item stored as a title with its offer. */
function plexEmitter(p: PlexConn, ctx: SyncContext) {
  const emitted = new Emitted<any>();
  return async (meta: any, ttype: "movie" | "show", summary: Summary, added?: number | null) => {
    const tid = await store.upsertTitle({ type: ttype, title: meta.title || "?", original_title: meta.originalTitle,
      year: meta.year, poster: p.poster(meta), ids: plexIds(meta.Guid, ttype), library: true });
    const [s, main, addedTs, first] = emitted.add(tid, summary, meta, Math.max(meta.addedAt || 0, added || 0) || null);
    await store.upsertOffer(tid, { source: p.source, provider: p.provider, provider_name: p.name, kind: "library", monetization: "library",
      url: p.link(main.ratingKey), extra: { rating_key: main.ratingKey, machine_id: p.machineId, server_type: "plex" },
      added_at: plexIso(addedTs || undefined), ...s }, ctx.started);
    if (first) ctx.items++;
  };
}

async function plexSync(srv: any, ctx: SyncContext): Promise<void> {
  const p = await plexConnect(srv, ctx);
  const { name, base, headers, detail } = p;
  const sections: any[] = (await get(base, "/library/sections", headers))?.MediaContainer?.Directory || [];
  const emit = plexEmitter(p, ctx);

  for (const [si, sec] of sections.entries()) {
    const label = sec.title || sec.key, share = si / Math.max(1, sections.length);
    if (sec.type === "movie") {
      ctx.progress(`${name}: ${label} – seznam filmů`, share);
      const movies: any[] = [];
      for await (const m of plexAll(base, headers, sec.key)) movies.push(m);
      ctx.progress(`${name}: ${label} – detaily ${movies.length} filmů`);
      const details = await pool(movies, DETAIL_CONCURRENCY, (m) => detail(m.ratingKey));
      for (const [i, m] of movies.entries()) {
        let s = plexBasic(m);
        if (details[i] && Object.keys(details[i]).length) s = merge(s, plexDetail(details[i]));
        await emit(m, "movie", s);
      }
    } else if (sec.type === "show") {
      ctx.progress(`${name}: ${label} – epizody`, share);
      const best = new Map<string, [any, Summary]>(), perShow = new Map<string, Summary>(), newest = new Map<string, number>();
      for await (const ep of plexAll(base, headers, sec.key, 4)) {
        const show = ep.grandparentRatingKey;
        if (!show) continue;
        const b = plexBasic(ep);
        if (ep.addedAt && ep.addedAt > (newest.get(show) || 0)) newest.set(show, ep.addedAt);
        perShow.set(show, merge(perShow.get(show), b));
        const cur = best.get(show);
        if (!cur || bestQuality(cur[1].quality, b.quality) !== cur[1].quality) best.set(show, [ep, b]);
      }
      const keys = [...best.keys()];
      const details = await pool(keys, DETAIL_CONCURRENCY, (k) => detail(best.get(k)![0].ratingKey));
      for (const [i, k] of keys.entries()) {
        if (details[i] && Object.keys(details[i]).length) perShow.set(k, merge(perShow.get(k), plexDetail(details[i])));
      }
      for await (const show of plexAll(base, headers, sec.key)) {
        await emit(show, "show", perShow.get(show.ratingKey) || plexBasic({}), newest.get(show.ratingKey));
      }
    }
  }
  const removed = await store.removeStale(p.source, ctx.started);
  ctx.note(`${name}: ${ctx.items} titulů, odstraněno ${removed}.`);
}

/** One title again: its library items now (quality, picture, ids), items of that name added since, and its
 *  offer gone when the item was deleted. */
async function plexRefresh(srv: any, title: store.RefreshTitle, ctx: SyncContext): Promise<void> {
  const p = await plexConnect(srv, ctx);
  const full = async (key: string) =>
    ((await getOr404(p.base, `/library/metadata/${key}`, p.headers, { includeGuids: 1 }))?.MediaContainer?.Metadata || [])[0] || null;
  const metas = new Map<string, any>();
  for (const o of title.offers) {
    const key = o.source === p.source ? o.extra?.rating_key : null;
    if (!key) continue;
    const m = await full(String(key));
    if (m) metas.set(String(key), m);
  }
  const want = title.type === "movie" ? "movie" : "show";
  for (const q of [...new Set([title.title, title.original_title].filter(Boolean) as string[])]) {
    const hubs = (await get(p.base, "/hubs/search", p.headers, { query: q, limit: 20, includeGuids: 1 }, 30000))?.MediaContainer?.Hub || [];
    for (const hub of hubs) for (const m of hub.Metadata || []) {
      const key = String(m.ratingKey || "");
      if (!key || metas.has(key) || m.type !== want) continue;
      if (!store.sameWork(title, m.title, m.originalTitle, m.year, plexIds(m.Guid, title.type))) continue;
      const d = await full(key);
      if (d && store.sameWork(title, d.title, d.originalTitle, d.year, plexIds(d.Guid, title.type))) metas.set(key, d);
    }
  }
  const emit = plexEmitter(p, ctx);
  for (const [key, meta] of metas) {
    if (title.type === "movie") { await emit(meta, "movie", merge(plexBasic(meta), plexDetail(meta))); continue; }
    const eps: any[] = (await get(p.base, `/library/metadata/${key}/allLeaves`, p.headers, undefined, 30000))?.MediaContainer?.Metadata || [];
    let summary = plexBasic({}), best: [any, Summary] | null = null, newest = 0;
    for (const ep of eps) {
      const b = plexBasic(ep);
      summary = merge(summary, b);
      newest = Math.max(newest, ep.addedAt || 0);
      if (!best || bestQuality(best[1].quality, b.quality) !== best[1].quality) best = [ep, b];
    }
    if (best) {
      const d = await p.detail(best[0].ratingKey).catch(() => null);
      if (d && Object.keys(d).length) summary = merge(summary, plexDetail(d));
    }
    await emit(meta, "show", summary, newest || null);
  }
  await store.removeStaleTitle(title.id, p.source, ctx.started);
}

// --- shared -----------------------------------------------------------------------
/** Android 17 asks for the home-network permission; only while the app is on screen (a prompt needs it). */
async function askLocalNetwork(): Promise<void> {
  if (env.localNetwork) await env.localNetwork(typeof document === "undefined" || document.visibilityState === "visible").catch(() => {});
}

export function serverSync(srv: any): (ctx: SyncContext) => Promise<void> {
  return async (ctx) => {
    await askLocalNetwork();
    return srv.type === "plex" ? plexSync(srv, ctx) : embySync(srv, ctx);
  };
}

/** The refresh button: this server's view of one title now. */
export async function serverRefresh(srv: any, title: store.RefreshTitle, ctx: SyncContext): Promise<void> {
  await askLocalNetwork();
  return srv.type === "plex" ? plexRefresh(srv, title, ctx) : embyRefresh(srv, title, ctx);
}

export async function testServer(srv: any): Promise<Record<string, unknown>> {
  await askLocalNetwork();
  if (srv.type === "plex") {
    const [base, ident] = await reachable(srv, "/identity", plexHeaders(srv));
    const mc = ident?.MediaContainer || {};
    return { id: mc.machineIdentifier, version: mc.version, via: base };
  }
  const [base, info] = await reachable(srv, "/System/Info", embyHeaders(srv));
  return { name: info?.ServerName, version: info?.Version, id: info?.Id, via: base };
}
