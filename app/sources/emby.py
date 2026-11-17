"""Emby and Jellyfin (same REST API family)."""

from __future__ import annotations

from collections import defaultdict
from urllib.parse import quote

from .. import store
from ..quality import (audio_tags, best_quality, langs, merge_tags, quality_from_dims,
                       video_tags)
from .base import SourceError, SyncContext, http_client

FIELDS = "ProviderIds,MediaSources,MediaStreams,OriginalTitle,ProductionYear,DateCreated"
PAGE = 300


def _headers(server: dict) -> dict:
    token = server.get("token", "")
    if server["type"] == "jellyfin":
        return {"Authorization": f'MediaBrowser Token="{token}"', "Accept": "application/json"}
    return {"X-Emby-Token": token, "Accept": "application/json"}


def _ids(provider_ids: dict | None, ttype: str) -> dict[str, str]:
    pid = {k.lower(): v for k, v in (provider_ids or {}).items() if v}
    out = {"imdb": pid.get("imdb"), "tvdb": pid.get("tvdb")}
    if pid.get("tmdb"):
        out["tmdb_movie" if ttype == "movie" else "tmdb_tv"] = pid["tmdb"]
    for k, v in pid.items():  # e.g. ČSFD plugin provider id
        if "csfd" in k:
            out["csfd"] = str(v).split("-")[0]
    return out


def media_summary(item: dict) -> dict:
    """Best quality + tags across all versions (MediaSources) of one item."""
    sources = item.get("MediaSources") or [{"MediaStreams": item.get("MediaStreams") or []}]
    q, video, audio, alangs, slangs = None, [], [], [], []
    for src in sources:
        for s in src.get("MediaStreams") or []:
            t = s.get("Type")
            if t == "Video":
                q = best_quality(q, quality_from_dims(s.get("Width"), s.get("Height")))
                video = merge_tags(video, video_tags(
                    s.get("VideoRange"), s.get("VideoRangeType"), s.get("ExtendedVideoType"),
                    s.get("ExtendedVideoSubType"), s.get("ExtendedVideoSubTypeDescription"),
                    s.get("DisplayTitle"), s.get("Title"), codec=s.get("Codec")))
            elif t == "Audio":
                audio = merge_tags(audio, audio_tags(
                    s.get("Profile"), s.get("DisplayTitle"), s.get("Title"),
                    codec=s.get("Codec"), channels=s.get("Channels")))
                alangs = merge_tags(alangs, langs([s.get("Language")]))
            elif t == "Subtitle":
                slangs = merge_tags(slangs, langs([s.get("Language")]))
    return {"quality": q, "video": video, "audio": audio, "audio_langs": alangs, "subtitle_langs": slangs}


def _merge_summary(a: dict | None, b: dict) -> dict:
    if not a:
        return b
    return {
        "quality": best_quality(a["quality"], b["quality"]),
        "video": merge_tags(a["video"], b["video"]),
        "audio": merge_tags(a["audio"], b["audio"]),
        "audio_langs": merge_tags(a["audio_langs"], b["audio_langs"]),
        "subtitle_langs": merge_tags(a["subtitle_langs"], b["subtitle_langs"]),
    }


class EmbyLike:
    def __init__(self, server: dict):
        self.server = server
        self.flavor = server["type"]  # emby | jellyfin
        self.base = server["url"].rstrip("/")
        self.public = (server.get("public_url") or self.base).rstrip("/")
        self.source = f"{self.flavor}:{server['id']}"

    def item_link(self, item_id: str, server_id: str) -> str:
        if self.flavor == "jellyfin":
            return f"{self.public}/web/#/details?id={item_id}&serverId={server_id}"
        return f"{self.public}/web/index.html#!/item?id={item_id}&serverId={server_id}"

    def poster(self, item: dict) -> str | None:
        if not (item.get("ImageTags") or {}).get("Primary"):
            return None
        path = f"/Items/{item['Id']}/Images/Primary?maxHeight=360&tag={item['ImageTags']['Primary']}"
        return f"/api/poster/{self.server['id']}?path={quote(path, safe='')}"

    async def _items(self, c, user_id: str, types: str, fields: str):
        start = 0
        while True:
            r = await c.get(f"/Users/{user_id}/Items", params={
                "Recursive": "true", "IncludeItemTypes": types, "Fields": fields,
                "StartIndex": start, "Limit": PAGE, "EnableImages": "true", "ImageTypeLimit": 1,
                "EnableUserData": "false",
            })
            r.raise_for_status()
            data = r.json()
            items = data.get("Items") or []
            for it in items:
                yield it
            start += len(items)
            if not items or start >= data.get("TotalRecordCount", 0):
                return

    async def test(self) -> dict:
        async with http_client(base_url=self.base, headers=_headers(self.server)) as c:
            info = (await c.get("/System/Info")).raise_for_status().json()
            return {"name": info.get("ServerName"), "version": info.get("Version"), "id": info.get("Id")}

    async def sync(self, ctx: SyncContext) -> None:
        name = self.server.get("name") or self.flavor.title()
        provider = f"{self.flavor}-{self.server['id']}"
        async with http_client(base_url=self.base, headers=_headers(self.server), timeout=120) as c:
            r = await c.get("/System/Info")
            if r.status_code in (401, 403):
                raise SourceError(f"{name}: neplatný API klíč (HTTP {r.status_code}).")
            info = r.raise_for_status().json()
            server_id = info.get("Id")
            users = (await c.get("/Users")).raise_for_status().json()
            admin = next((u for u in users if (u.get("Policy") or {}).get("IsAdministrator")), users[0] if users else None)
            if not admin:
                raise SourceError(f"{name}: na serveru není žádný uživatel.")
            uid = admin["Id"]

            # several library items can be one title (two copies of a film, another version with more
            # audio tracks): their tracks are added up, the link goes to the best copy
            emitted: dict[int, tuple[dict, dict, str | None]] = {}

            async def emit(item: dict, ttype: str, summary: dict, added: str | None = None) -> None:
                tid = await store.upsert_title(store.TitleInfo(
                    type=ttype, title=item.get("Name") or "?", original_title=item.get("OriginalTitle"),
                    year=item.get("ProductionYear"), poster=self.poster(item),
                    ids=_ids(item.get("ProviderIds"), ttype), authoritative=("csfd",), library=True,
                ))
                added_at = max(filter(None, (item.get("DateCreated"), added)), default=None)
                main = item
                if tid in emitted:
                    prev_summary, prev_item, prev_added = emitted[tid]
                    if best_quality(prev_summary["quality"], summary["quality"]) == prev_summary["quality"]:
                        main = prev_item
                    summary = _merge_summary(prev_summary, summary)
                    added_at = max(filter(None, (prev_added, added_at)), default=None)
                else:
                    ctx.items += 1
                emitted[tid] = (summary, main, added_at)
                await store.upsert_offer(tid, store.Offer(
                    source=self.source, provider=provider, provider_name=name, kind="library",
                    monetization="library", url=self.item_link(main["Id"], server_id),
                    extra={"item_id": main["Id"], "server_id": server_id, "server_type": self.flavor},
                    added_at=added_at, **summary,
                ), ctx.started)

            ctx.progress(f"{name}: filmy", 0)
            async for it in self._items(c, uid, "Movie", FIELDS):
                await emit(it, "movie", media_summary(it))

            per_series: dict[str, dict] = defaultdict(dict)
            newest_ep: dict[str, str] = {}
            ctx.progress(f"{name}: kvalita epizod", 1 / 3)
            n_eps = 0
            async for ep in self._items(c, uid, "Episode", "MediaSources,MediaStreams,DateCreated"):
                n_eps += 1
                if n_eps % 500 == 0:
                    ctx.progress(f"{name}: kvalita epizod ({n_eps})")
                sid = ep.get("SeriesId")
                if sid:
                    per_series[sid] = _merge_summary(per_series.get(sid), media_summary(ep))
                    if ep.get("DateCreated") and ep["DateCreated"] > newest_ep.get(sid, ""):
                        newest_ep[sid] = ep["DateCreated"]   # a series is "new" when an episode arrives
            ctx.progress(f"{name}: seriály", 2 / 3)
            async for series in self._items(c, uid, "Series", "ProviderIds,OriginalTitle,ProductionYear,DateCreated"):
                summary = per_series.get(series["Id"]) or media_summary({})
                await emit(series, "show", summary, newest_ep.get(series["Id"]))

        removed = await store.remove_stale(self.source, ctx.started)
        ctx.note(f"{name}: {ctx.items} titulů, odstraněno {removed}.")
