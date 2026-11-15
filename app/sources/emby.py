"""Emby and Jellyfin (same REST API family)."""

from __future__ import annotations

from collections import defaultdict
from urllib.parse import quote

from .. import store
from ..quality import (audio_tags, best_quality, langs, merge_tags, quality_from_dims,
                       video_tags)
from .base import SourceError, SyncContext, http_client

FIELDS = "ProviderIds,MediaSources,MediaStreams,OriginalTitle,ProductionYear"
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

            async def emit(item: dict, ttype: str, summary: dict) -> None:
                tid = await store.upsert_title(store.TitleInfo(
                    type=ttype, title=item.get("Name") or "?", original_title=item.get("OriginalTitle"),
                    year=item.get("ProductionYear"), poster=self.poster(item),
                    ids=_ids(item.get("ProviderIds"), ttype),
                ))
                await store.upsert_offer(tid, store.Offer(
                    source=self.source, provider=provider, provider_name=name, kind="library",
                    monetization="library", url=self.item_link(item["Id"], server_id),
                    extra={"item_id": item["Id"], "server_id": server_id, "server_type": self.flavor},
                    **summary,
                ), ctx.started)
                ctx.items += 1

            async for it in self._items(c, uid, "Movie", FIELDS):
                await emit(it, "movie", media_summary(it))

            per_series: dict[str, dict] = defaultdict(dict)
            async for ep in self._items(c, uid, "Episode", "MediaSources,MediaStreams"):
                sid = ep.get("SeriesId")
                if sid:
                    per_series[sid] = _merge_summary(per_series.get(sid), media_summary(ep))
            async for series in self._items(c, uid, "Series", "ProviderIds,OriginalTitle,ProductionYear"):
                summary = per_series.get(series["Id"]) or media_summary({})
                await emit(series, "show", summary)

        removed = await store.remove_stale(self.source, ctx.started)
        ctx.note(f"{name}: {ctx.items} titulů, odstraněno {removed}.")
