"""Plex Media Server."""

from __future__ import annotations

import asyncio
from collections import defaultdict
from urllib.parse import quote

from .. import store
from ..quality import (audio_tags, best_quality, langs, merge_tags, quality_from_dims,
                       quality_from_label, video_tags)
from .base import SourceError, SyncContext, http_client

PAGE = 300


def _iso(ts: int | None) -> str | None:
    import datetime as dt
    return dt.datetime.fromtimestamp(ts, dt.UTC).isoformat(timespec="seconds") if ts else None
DETAIL_CONCURRENCY = 4


def _ids_from_guids(guids: list[dict] | None, ttype: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for g in guids or []:
        gid = g.get("id", "")
        if "://" not in gid:
            continue
        scheme, value = gid.split("://", 1)
        if scheme == "imdb":
            out["imdb"] = value
        elif scheme == "tmdb":
            out["tmdb_movie" if ttype == "movie" else "tmdb_tv"] = value
        elif scheme == "tvdb":
            out["tvdb"] = value
    return out


def _media_basic(meta: dict) -> dict:
    """Summary from list endpoints (resolution, codecs, channels)."""
    q, video, audio = None, [], []
    for m in meta.get("Media") or []:
        q = best_quality(q, quality_from_label(m.get("videoResolution")) or quality_from_dims(m.get("width"), m.get("height")))
        video = merge_tags(video, video_tags(codec=m.get("videoCodec")))
        audio = merge_tags(audio, audio_tags(m.get("audioProfile"), codec=m.get("audioCodec"), channels=m.get("audioChannels")))
    return {"quality": q, "video": video, "audio": audio, "audio_langs": [], "subtitle_langs": []}


def _media_detail(meta: dict) -> dict:
    """Summary from /library/metadata/{key}: adds HDR/DV, Atmos and languages from streams."""
    base = _media_basic(meta)
    video, audio, alangs, slangs = base["video"], base["audio"], [], []
    for m in meta.get("Media") or []:
        for part in m.get("Part") or []:
            for s in part.get("Stream") or []:
                st = s.get("streamType")
                if st == 1:
                    texts = [s.get("displayTitle"), s.get("extendedDisplayTitle"), s.get("colorTrc")]
                    if s.get("DOVIPresent"):
                        texts.append("dolby vision")
                    video = merge_tags(video, video_tags(*texts, codec=s.get("codec")))
                elif st == 2:
                    audio = merge_tags(audio, audio_tags(
                        s.get("displayTitle"), s.get("extendedDisplayTitle"), s.get("title"), s.get("profile"),
                        codec=s.get("codec"), channels=s.get("channels")))
                    alangs = merge_tags(alangs, langs([s.get("languageCode") or s.get("languageTag")]))
                elif st == 3:
                    slangs = merge_tags(slangs, langs([s.get("languageCode") or s.get("languageTag")]))
    return {**base, "video": video, "audio": audio, "audio_langs": alangs, "subtitle_langs": slangs}


def _merge(a: dict | None, b: dict) -> dict:
    if not a:
        return b
    return {
        "quality": best_quality(a["quality"], b["quality"]),
        "video": merge_tags(a["video"], b["video"]), "audio": merge_tags(a["audio"], b["audio"]),
        "audio_langs": merge_tags(a["audio_langs"], b["audio_langs"]),
        "subtitle_langs": merge_tags(a["subtitle_langs"], b["subtitle_langs"]),
    }


class Plex:
    def __init__(self, server: dict):
        self.server = server
        self.base = server["url"].rstrip("/")
        self.public = (server.get("public_url") or "").rstrip("/")
        self.source = f"plex:{server['id']}"
        self.headers = {"X-Plex-Token": server.get("token", ""), "Accept": "application/json",
                        "X-Plex-Product": "Medialect", "X-Plex-Client-Identifier": f"medialect-{server['id']}"}

    def link(self, machine_id: str, rating_key: str) -> str:
        key = quote(f"/library/metadata/{rating_key}", safe="")
        if self.public:
            return f"{self.public}/web/index.html#!/server/{machine_id}/details?key={key}"
        return f"https://app.plex.tv/desktop/#!/server/{machine_id}/details?key={key}"

    def poster(self, meta: dict) -> str | None:
        # Plex images need the token, so they are served through the backend's poster proxy
        thumb = meta.get("thumb")
        if not thumb:
            return None
        path = f"/photo/:/transcode?width=240&height=360&minSize=1&url={quote(thumb, safe='')}"
        return f"/api/poster/{self.server['id']}?path={quote(path, safe='')}"

    async def _all(self, c, section: str, type_: int | None = None):
        start = 0
        while True:
            params = {"includeGuids": 1, "X-Plex-Container-Start": start, "X-Plex-Container-Size": PAGE}
            if type_:
                params["type"] = type_
            r = await c.get(f"/library/sections/{section}/all", params=params)
            r.raise_for_status()
            mc = r.json().get("MediaContainer") or {}
            items = mc.get("Metadata") or []
            for it in items:
                yield it
            start += len(items)
            if not items or start >= mc.get("totalSize", mc.get("size", 0)):
                return

    async def _detail(self, c, sem, rating_key: str) -> dict:
        async with sem:
            r = await c.get(f"/library/metadata/{rating_key}")
            r.raise_for_status()
            items = (r.json().get("MediaContainer") or {}).get("Metadata") or []
            return items[0] if items else {}

    async def test(self) -> dict:
        async with http_client(base_url=self.base, headers=self.headers) as c:
            mc = (await c.get("/identity")).raise_for_status().json().get("MediaContainer", {})
            return {"id": mc.get("machineIdentifier"), "version": mc.get("version")}

    async def _connect(self, c) -> str:
        """The server's machine id (part of its links)."""
        name = self.server.get("name") or "Plex"
        r = await c.get("/identity")
        if r.status_code in (401, 403):
            raise SourceError(f"{name}: neplatný token (HTTP {r.status_code}).")
        return r.raise_for_status().json()["MediaContainer"]["machineIdentifier"]

    def _emitter(self, ctx: SyncContext, machine_id: str):
        """emit(meta, type, summary, added): stores one library item as a title with its offer. Several library
        items can be one title (the same film in two sections or two copies): their tracks are added up, the
        link goes to the best copy."""
        name = self.server.get("name") or "Plex"
        provider = f"plex-{self.server['id']}"
        emitted: dict[int, tuple[dict, dict, int | None]] = {}

        async def emit(meta: dict, ttype: str, summary: dict, added: int | None = None) -> int:
            tid = await store.upsert_title(store.TitleInfo(
                type=ttype, title=meta.get("title") or "?", original_title=meta.get("originalTitle"),
                year=meta.get("year"), poster=self.poster(meta),
                ids=_ids_from_guids(meta.get("Guid"), ttype), library=True,
            ))
            added_ts = max(filter(None, (meta.get("addedAt"), added)), default=None)
            main = meta
            if tid in emitted:
                prev_summary, prev_meta, prev_added = emitted[tid]
                if best_quality(prev_summary["quality"], summary["quality"]) == prev_summary["quality"]:
                    main = prev_meta
                summary = _merge(prev_summary, summary)
                added_ts = max(filter(None, (prev_added, added_ts)), default=None)
            else:
                ctx.items += 1
            emitted[tid] = (summary, main, added_ts)
            await store.upsert_offer(tid, store.Offer(
                source=self.source, provider=provider, provider_name=name, kind="library",
                monetization="library", url=self.link(machine_id, main["ratingKey"]),
                extra={"rating_key": main["ratingKey"], "machine_id": machine_id, "server_type": "plex"},
                added_at=_iso(added_ts), **summary,
            ), ctx.started)
            return tid
        return emit

    async def refresh_title(self, title: dict, ctx: SyncContext) -> None:
        """One title again: its library items now (quality, picture, ids), items of that name added since,
        and its offer gone when the item was deleted."""
        ttype = title["type"]
        sem = asyncio.Semaphore(DETAIL_CONCURRENCY)
        async with http_client(base_url=self.base, headers=self.headers, timeout=30) as c:
            machine_id = await self._connect(c)

            async def detail(key: str) -> dict | None:
                r = await c.get(f"/library/metadata/{key}", params={"includeGuids": 1})
                if r.status_code in (400, 404):
                    return None
                r.raise_for_status()
                found = (r.json().get("MediaContainer") or {}).get("Metadata") or []
                return found[0] if found else None

            metas: dict[str, dict] = {}
            for o in title["offers"]:
                key = o["extra"].get("rating_key") if o["source"] == self.source else None
                if key and (m := await detail(str(key))):
                    metas[str(key)] = m
            want = "movie" if ttype == "movie" else "show"
            for q in dict.fromkeys(n for n in (title["title"], title["original_title"]) if n):
                r = await c.get("/hubs/search", params={"query": q, "limit": 20, "includeGuids": 1})
                r.raise_for_status()
                for hub in (r.json().get("MediaContainer") or {}).get("Hub") or []:
                    for m in hub.get("Metadata") or []:
                        key = str(m.get("ratingKey") or "")
                        if not key or key in metas or m.get("type") != want:
                            continue
                        if store.same_work(title, m.get("title"), m.get("originalTitle"), m.get("year"),
                                           _ids_from_guids(m.get("Guid"), ttype)) and (d := await detail(key)):
                            if store.same_work(title, d.get("title"), d.get("originalTitle"), d.get("year"),
                                               _ids_from_guids(d.get("Guid"), ttype)):
                                metas[key] = d
            emit = self._emitter(ctx, machine_id)
            for key, meta in metas.items():
                if ttype == "movie":
                    await emit(meta, "movie", _merge(_media_basic(meta), _media_detail(meta)))
                    continue
                r = await c.get(f"/library/metadata/{key}/allLeaves")
                r.raise_for_status()
                eps = (r.json().get("MediaContainer") or {}).get("Metadata") or []
                summary, best, newest = _media_basic({}), None, None
                for ep in eps:
                    b = _media_basic(ep)
                    summary = _merge(summary, b)
                    newest = max(filter(None, (newest, ep.get("addedAt"))), default=None)
                    if not best or best_quality(best[1]["quality"], b["quality"]) != best[1]["quality"]:
                        best = (ep, b)
                if best and (d := await self._detail(c, sem, best[0]["ratingKey"])):
                    summary = _merge(summary, _media_detail(d))
                await emit(meta, "show", summary, newest)
        await store.remove_stale_title(title["id"], self.source, ctx.started)

    async def sync(self, ctx: SyncContext) -> None:
        name = self.server.get("name") or "Plex"
        sem = asyncio.Semaphore(DETAIL_CONCURRENCY)
        async with http_client(base_url=self.base, headers=self.headers, timeout=120) as c:
            machine_id = await self._connect(c)
            r = await c.get("/library/sections")
            if r.status_code in (401, 403):
                raise SourceError(f"{name}: neplatný X-Plex-Token (HTTP {r.status_code}).")
            sections = r.raise_for_status().json()["MediaContainer"].get("Directory") or []
            emit = self._emitter(ctx, machine_id)

            for si, sec in enumerate(sections):
                label = sec.get("title") or sec["key"]
                share = si / max(1, len(sections))
                if sec.get("type") == "movie":
                    ctx.progress(f"{name}: {label} – seznam filmů", share)
                    movies = [m async for m in self._all(c, sec["key"])]
                    ctx.progress(f"{name}: {label} – detaily {len(movies)} filmů")
                    details = await asyncio.gather(*(self._detail(c, sem, m["ratingKey"]) for m in movies),
                                                   return_exceptions=True)
                    for m, d in zip(movies, details):
                        summary = _media_basic(m)
                        if isinstance(d, dict) and d:
                            summary = _merge(summary, _media_detail(d))
                        await emit(m, "movie", summary)
                elif sec.get("type") == "show":
                    # episodes (type=4) carry Media; aggregate per show, then detail one best episode per show
                    best_ep: dict[str, tuple[dict, dict]] = {}
                    per_show: dict[str, dict] = defaultdict(dict)
                    newest_ep: dict[str, int] = {}
                    ctx.progress(f"{name}: {label} – epizody", share)
                    async for ep in self._all(c, sec["key"], 4):
                        show_key = ep.get("grandparentRatingKey")
                        if not show_key:
                            continue
                        b = _media_basic(ep)
                        if ep.get("addedAt") and ep["addedAt"] > newest_ep.get(show_key, 0):
                            newest_ep[show_key] = ep["addedAt"]
                        per_show[show_key] = _merge(per_show.get(show_key), b)
                        cur = best_ep.get(show_key)
                        if not cur or best_quality(cur[1]["quality"], b["quality"]) != cur[1]["quality"]:
                            best_ep[show_key] = (ep, b)
                    details = await asyncio.gather(*(self._detail(c, sem, ep["ratingKey"]) for ep, _ in best_ep.values()),
                                                   return_exceptions=True)
                    for (show_key, _), d in zip(best_ep.items(), details):
                        if isinstance(d, dict) and d:
                            per_show[show_key] = _merge(per_show[show_key], _media_detail(d))
                    async for show in self._all(c, sec["key"]):
                        await emit(show, "show", per_show.get(show["ratingKey"]) or _media_basic({}),
                                   newest_ep.get(show["ratingKey"]))

        removed = await store.remove_stale(self.source, ctx.started)
        ctx.note(f"{name}: {ctx.items} titulů, odstraněno {removed}.")
