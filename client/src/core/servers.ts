// Media servers: Emby, Jellyfin and Plex (port of app/sources/emby.py and app/sources/plex.py).
import type { SyncContext } from "./context";
import { http, SourceError } from "./env";
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

async function get(base: string, path: string, headers: Record<string, string>, params?: Record<string, unknown>) {
  const r = await http(base + path, { headers, params, timeoutMs: 120000 });
  if (r.status === 401 || r.status === 403) throw new SourceError(`${new URL(base).host}: neplatný API klíč / token (HTTP ${r.status}).`);
  if (!r.ok) throw new SourceError(`${new URL(base).host}: HTTP ${r.status}`);
  return r.data;
}

// --- Emby / Jellyfin ------------------------------------------------------------
const EMBY_FIELDS = "ProviderIds,MediaSources,MediaStreams,OriginalTitle,ProductionYear,DateCreated";

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

async function* embyItems(base: string, headers: Record<string, string>, userId: string, types: string, fields: string) {
  let start = 0;
  for (;;) {
    const data = await get(base, `/Users/${userId}/Items`, headers, {
      Recursive: "true", IncludeItemTypes: types, Fields: fields, StartIndex: start, Limit: PAGE,
      EnableImages: "true", ImageTypeLimit: 1, EnableUserData: "false" });
    const items = data?.Items || [];
    for (const it of items) yield it;
    start += items.length;
    if (!items.length || start >= (data?.TotalRecordCount || 0)) return;
  }
}

async function embySync(srv: any, ctx: SyncContext): Promise<void> {
  const flavor = srv.type as "emby" | "jellyfin";
  const name = srv.name || (flavor === "emby" ? "Emby" : "Jellyfin");
  const base = trimSlash(srv.url), view = viewBase(srv), headers = embyHeaders(srv);
  const source = `${flavor}:${srv.id}`, provider = `${flavor}-${srv.id}`;
  const info = await get(base, "/System/Info", headers);
  const serverId = info?.Id;
  const users: any[] = (await get(base, "/Users", headers)) || [];
  const admin = users.find((u) => u?.Policy?.IsAdministrator) || users[0];
  if (!admin) throw new SourceError(`${name}: na serveru není žádný uživatel.`);
  const link = (id: string) => flavor === "jellyfin"
    ? `${view}/web/#/details?id=${id}&serverId=${serverId}`
    : `${view}/web/index.html#!/item?id=${id}&serverId=${serverId}`;
  // images of Emby and Jellyfin need no token
  const poster = (it: any) => it.ImageTags?.Primary
    ? `${view}/Items/${it.Id}/Images/Primary?maxHeight=360&tag=${it.ImageTags.Primary}` : null;

  const emit = async (item: any, ttype: "movie" | "show", summary: Summary, added?: string) => {
    const tid = await store.upsertTitle({ type: ttype, title: item.Name || "?", original_title: item.OriginalTitle,
      year: item.ProductionYear, poster: poster(item), ids: embyIds(item.ProviderIds, ttype), authoritative: ["csfd"] });
    const dates = [item.DateCreated, added].filter(Boolean).sort();
    await store.upsertOffer(tid, { source, provider, provider_name: name, kind: "library", monetization: "library",
      url: link(item.Id), extra: { item_id: item.Id, server_id: serverId, server_type: flavor },
      added_at: dates.length ? dates[dates.length - 1] : null, ...summary }, ctx.started);
    ctx.items++;
  };

  ctx.progress(`${name}: filmy`, 0);
  for await (const it of embyItems(base, headers, admin.Id, "Movie", EMBY_FIELDS)) await emit(it, "movie", embySummary(it));
  const perSeries = new Map<string, Summary>(), newestEp = new Map<string, string>();
  ctx.progress(`${name}: kvalita epizod`, 1 / 3);
  let n = 0;
  for await (const ep of embyItems(base, headers, admin.Id, "Episode", "MediaSources,MediaStreams,DateCreated")) {
    if (++n % 500 === 0) ctx.progress(`${name}: kvalita epizod (${n})`);
    if (!ep.SeriesId) continue;
    perSeries.set(ep.SeriesId, merge(perSeries.get(ep.SeriesId), embySummary(ep)));
    if (ep.DateCreated && ep.DateCreated > (newestEp.get(ep.SeriesId) || "")) newestEp.set(ep.SeriesId, ep.DateCreated);
  }
  ctx.progress(`${name}: seriály`, 2 / 3);
  for await (const s of embyItems(base, headers, admin.Id, "Series", "ProviderIds,OriginalTitle,ProductionYear,DateCreated")) {
    await emit(s, "show", perSeries.get(s.Id) || embySummary({}), newestEp.get(s.Id));
  }
  const removed = await store.removeStale(source, ctx.started);
  ctx.note(`${name}: ${ctx.items} titulů, odstraněno ${removed}.`);
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

async function plexSync(srv: any, ctx: SyncContext): Promise<void> {
  const name = srv.name || "Plex";
  const base = trimSlash(srv.url), headers = plexHeaders(srv);
  const source = `plex:${srv.id}`, provider = `plex-${srv.id}`;
  const pub = trimSlash(srv.public_url), view = viewBase(srv);
  const machineId = (await get(base, "/identity", headers))?.MediaContainer?.machineIdentifier;
  const sections: any[] = (await get(base, "/library/sections", headers))?.MediaContainer?.Directory || [];
  const detail = async (key: string) => ((await get(base, `/library/metadata/${key}`, headers))?.MediaContainer?.Metadata || [])[0] || {};
  const link = (key: string) => {
    const k = encodeURIComponent(`/library/metadata/${key}`);
    const root = srv.link_mode === "internal" ? base : pub;
    return root ? `${root}/web/index.html#!/server/${machineId}/details?key=${k}`
      : `https://app.plex.tv/desktop/#!/server/${machineId}/details?key=${k}`;
  };
  // Plex images need the token
  const poster = (m: any) => m.thumb
    ? `${view}/photo/:/transcode?width=240&height=360&minSize=1&url=${encodeURIComponent(m.thumb)}&X-Plex-Token=${encodeURIComponent(srv.token || "")}`
    : null;
  const iso = (ts?: number) => (ts ? new Date(ts * 1000).toISOString().slice(0, 19) : null);

  const emit = async (meta: any, ttype: "movie" | "show", summary: Summary, added?: number) => {
    const tid = await store.upsertTitle({ type: ttype, title: meta.title || "?", original_title: meta.originalTitle,
      year: meta.year, poster: poster(meta), ids: plexIds(meta.Guid, ttype) });
    await store.upsertOffer(tid, { source, provider, provider_name: name, kind: "library", monetization: "library",
      url: link(meta.ratingKey), extra: { rating_key: meta.ratingKey, machine_id: machineId, server_type: "plex" },
      added_at: iso(Math.max(meta.addedAt || 0, added || 0) || undefined), ...summary }, ctx.started);
    ctx.items++;
  };

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
  const removed = await store.removeStale(source, ctx.started);
  ctx.note(`${name}: ${ctx.items} titulů, odstraněno ${removed}.`);
}

// --- shared -----------------------------------------------------------------------
export function serverSync(srv: any): (ctx: SyncContext) => Promise<void> {
  return (ctx) => (srv.type === "plex" ? plexSync(srv, ctx) : embySync(srv, ctx));
}

export async function testServer(srv: any): Promise<Record<string, unknown>> {
  const base = trimSlash(srv.url);
  if (srv.type === "plex") {
    const mc = (await get(base, "/identity", plexHeaders(srv)))?.MediaContainer || {};
    return { id: mc.machineIdentifier, version: mc.version };
  }
  const info = await get(base, "/System/Info", embyHeaders(srv));
  return { name: info?.ServerName, version: info?.Version, id: info?.Id };
}
