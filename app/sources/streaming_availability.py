"""Streaming Availability API (Movie of the Night), v4.

Walks /shows/search/filters per catalogue and show type with cursor pagination.
The walk is resumable: the cursor is saved, so a small daily request budget
finishes a big catalogue over several days.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import time

from .. import store
from ..db import db
from ..quality import langs, provider_key, quality_from_label
from .base import SourceError, SyncContext, http_client

SOURCE = "sa"
DIRECT_BASE = "https://api.movieofthenight.com/v4"
RAPID_HOST = "streaming-availability.p.rapidapi.com"
KEEP_TYPES = {"subscription": "flatrate", "free": "free", "addon": "addon"}
STATE_KEY = "sa.state"


def _client(cfg: dict):
    if not cfg.get("api_key"):
        raise SourceError("Chybí API klíč pro Streaming Availability.")
    if cfg.get("mode") == "rapidapi":
        return http_client(base_url=f"https://{RAPID_HOST}",
                           headers={"X-RapidAPI-Key": cfg["api_key"], "X-RapidAPI-Host": RAPID_HOST})
    return http_client(base_url=DIRECT_BASE, headers={"X-API-Key": cfg["api_key"]})


def _tmdb_ids(tmdb: str | None) -> dict[str, str]:
    if not tmdb or "/" not in tmdb:
        return {}
    kind, value = tmdb.split("/", 1)
    return {"tmdb_movie" if kind == "movie" else "tmdb_tv": value}


async def store_show(ctx: SyncContext, show: dict, catalogs: set[str]) -> None:
    ttype = "movie" if show.get("showType") == "movie" else "show"
    poster = ((show.get("imageSet") or {}).get("verticalPoster") or {}).get("w240")
    tid = await store.upsert_title(store.TitleInfo(
        type=ttype,
        title=show.get("title") or show.get("originalTitle") or "?",
        original_title=show.get("originalTitle"),
        year=show.get("releaseYear") or show.get("firstAirYear"),
        poster=poster,
        ids={"sa": show.get("id"), "imdb": show.get("imdbId"), **_tmdb_ids(show.get("tmdbId"))},
    ))
    country = ctx.settings["country"].lower()
    for opt in (show.get("streamingOptions") or {}).get(country, []):
        service = opt.get("service") or {}
        if catalogs and service.get("id") not in catalogs:
            continue
        mon = KEEP_TYPES.get(opt.get("type"))
        if not mon:
            continue
        expires = opt.get("expiresOn")
        await store.upsert_offer(tid, store.Offer(
            source=SOURCE,
            provider=provider_key(service.get("id") or service.get("name", "")),
            provider_name=service.get("name") or service.get("id"),
            kind="stream",
            monetization=mon,
            quality=quality_from_label(opt.get("quality")),
            audio_langs=langs(a.get("language") for a in opt.get("audios") or []),
            subtitle_langs=langs(((s.get("locale") or {}).get("language")) for s in opt.get("subtitles") or []),
            url=opt.get("link"),
            extra={k: v for k, v in {
                "video_link": opt.get("videoLink"),
                "addon": (opt.get("addon") or {}).get("name"),
                "expires_soon": opt.get("expiresSoon"),
            }.items() if v},
            expires_on=dt.datetime.fromtimestamp(expires, dt.UTC).date().isoformat() if expires else None,
            added_at=(dt.datetime.fromtimestamp(opt["availableSince"], dt.UTC).isoformat(timespec="seconds")
                      if opt.get("availableSince") else None),
        ), time.time())
    ctx.items += 1


async def lookup(settings: dict, ext_id: str) -> dict | None:
    """Single title lookup (IMDb id 'tt..' or 'movie/123' / 'tv/123')."""
    cfg = settings["streaming_availability"]
    if not await db.budget_take("sa", cfg.get("daily_budget", 90)):
        raise SourceError("Denní limit Streaming Availability vyčerpán.")
    async with _client(cfg) as c:
        r = await c.get(f"/shows/{ext_id}", params={"country": settings["country"].lower(), "series_granularity": "show"})
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()


async def sync(ctx: SyncContext) -> None:
    cfg = ctx.settings["streaming_availability"]
    catalogs = list(cfg.get("catalogs") or [])
    if not catalogs:
        ctx.note("Nejsou vybrané žádné katalogy.")
        return
    budget = int(cfg.get("daily_budget", 90))
    state: dict = await db.kv_get(STATE_KEY, {})
    country = ctx.settings["country"].lower()

    async with _client(cfg) as c:
        for cat in catalogs:
            for show_type in ("movie", "series"):
                key = f"{country}:{cat}:{show_type}"
                st = state.get(key) or {}
                st.setdefault("started", time.time())
                page = 0
                while True:
                    page += 1
                    ctx.progress(f"{cat} / {'filmy' if show_type == 'movie' else 'seriály'}: stránka {page}")
                    if not await db.budget_take("sa", budget):
                        ctx.partial = True
                        state[key] = st
                        await db.kv_set(STATE_KEY, state)
                        ctx.note(f"Denní limit vyčerpán, pokračuji zítra ({cat}/{show_type}).")
                        return
                    params = {"country": country, "catalogs": cat, "show_type": show_type,
                              "series_granularity": "show", "order_by": "original_title"}
                    if st.get("cursor"):
                        params["cursor"] = st["cursor"]
                    r = await c.get("/shows/search/filters", params=params)
                    if r.status_code == 429:
                        ctx.partial = True
                        state[key] = st
                        await db.kv_set(STATE_KEY, state)
                        ctx.note("API vrátilo 429 (limit), pokračuji při dalším běhu.")
                        return
                    if r.status_code >= 400:
                        raise SourceError(f"Streaming Availability {r.status_code}: {r.text[:200]}")
                    data = r.json()
                    for show in data.get("shows", []):
                        await store_show(ctx, show, {cat})
                    if data.get("hasMore") and data.get("nextCursor"):
                        st["cursor"] = data["nextCursor"]
                        state[key] = st
                        await db.kv_set(STATE_KEY, state)
                        await asyncio.sleep(0.3)
                        continue
                    # catalogue fully walked: drop offers not seen since this walk started
                    removed = await store.remove_stale(SOURCE, st["started"], provider_key(cat),
                                                       "movie" if show_type == "movie" else "show")
                    ctx.note(f"{cat}/{show_type}: kompletní, odstraněno {removed} neaktuálních.")
                    state.pop(key, None)
                    await db.kv_set(STATE_KEY, state)
                    break


async def refresh_title(title: dict, ctx: SyncContext) -> None:
    """One title again: its Streaming Availability entry now (one request of the daily budget)."""
    cfg = ctx.settings["streaming_availability"]
    ids = title["ids"]
    ext = ids.get("imdb") or (f"movie/{ids['tmdb_movie']}" if ids.get("tmdb_movie") else
                              f"tv/{ids['tmdb_tv']}" if ids.get("tmdb_tv") else None)
    if not ext:
        return
    show = await lookup(ctx.settings, ext)
    if show:
        await store_show(ctx, show, set(cfg.get("catalogs") or []))
    await store.remove_stale_title(title["id"], SOURCE, ctx.started)
