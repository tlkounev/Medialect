"""JustWatch (unofficial GraphQL via simple-justwatch-python-api).

Lists the whole catalogue of each selected provider. JustWatch returns at most 1999
titles per query, so the catalogue is walked in release-year windows per object
type; a window that hits the cap is split in half.
"""

from __future__ import annotations

import asyncio
import datetime as dt

from simplejustwatchapi import justwatch as jw
from simplejustwatchapi.exceptions import JustWatchError

from .. import store
from ..db import db
from ..quality import justwatch_tech, langs, provider_key, quality_from_label
from .base import SourceError, SyncContext

SOURCE = "justwatch"
PAGE = 50
CAP = 1999
KEEP_MONETIZATION = {"FLATRATE": "flatrate", "FREE": "free", "ADS": "ads", "FAST": "free"}


def _windows() -> list[tuple[int, int]]:
    year = dt.date.today().year
    return [(1900, 1969), (1970, 1989), (1990, 1999), (2000, 2009), (2010, 2014), (2015, 2018),
            (2019, 2021), (2022, 2023)] + [(y, y) for y in range(2024, year + 3)]


async def list_providers(country: str) -> list[dict]:
    packages = await asyncio.to_thread(jw.providers, country)
    out = []
    for p in packages:
        mt = [m.upper() for m in (p.monetization_types or [])]
        if not set(mt) & set(KEEP_MONETIZATION):
            continue
        out.append({"short_name": p.short_name, "name": p.name, "technical_name": p.technical_name,
                    "icon": p.icon, "monetization_types": mt})
    # short name (settings) -> provider key (catalogue), for ordering offers by the user's service order
    keys = await db.kv_get("jw.provider_keys", {})
    keys.update({p["short_name"]: provider_key(p["technical_name"] or p["name"]) for p in out})
    await db.kv_set("jw.provider_keys", keys)
    return sorted(out, key=lambda p: p["name"].lower())


async def _popular(country, language, count, offset, provider, lo, hi, otype):
    return await asyncio.to_thread(
        jw.popular, country, language, count, True, offset, provider, lo, hi, otype
    )


async def _fetch_window(ctx, provider, otype, lo, hi, delay) -> tuple[list, bool]:
    s = ctx.settings
    results, offset = [], 0
    while True:
        count = min(PAGE, CAP - offset)
        if count <= 0:
            return results, True
        for attempt in range(3):
            try:
                batch = await _popular(s["country"], s["language"], count, offset, provider, lo, hi, otype)
                break
            except JustWatchError as e:
                if attempt == 2:
                    raise SourceError(f"JustWatch: {e}") from e
                await asyncio.sleep(5 * (attempt + 1))
        await asyncio.sleep(delay)
        results.extend(batch)
        if len(batch) < count:
            return results, False
        offset += count


async def _store_entry(ctx: SyncContext, entry, selected: dict[str, str]) -> None:
    ttype = "movie" if entry.object_type == "MOVIE" else "show"
    ids = {"jw": entry.entry_id, "imdb": entry.imdb_id}
    if entry.tmdb_id:
        ids["tmdb_movie" if ttype == "movie" else "tmdb_tv"] = entry.tmdb_id
    tid = await store.upsert_title(store.TitleInfo(
        type=ttype, title=entry.title, year=entry.release_year, poster=entry.poster, ids=ids,
    ))
    for o in entry.offers or []:
        pkg = o.package
        if not pkg or pkg.short_name not in selected:
            continue
        mon = KEEP_MONETIZATION.get((o.monetization_type or "").upper())
        if not mon:
            continue
        await store.upsert_offer(tid, store.Offer(
            source=SOURCE,
            provider=provider_key(pkg.technical_name or pkg.name),
            provider_name=pkg.name,
            kind="stream",
            monetization=mon,
            quality=quality_from_label(o.presentation_type),
            video=justwatch_tech(o.video_technology, "video"),
            audio=justwatch_tech(o.audio_technology, "audio"),
            audio_langs=langs(o.audio_languages),
            subtitle_langs=langs(o.subtitle_languages),
            url=o.url,
            extra={"jw_url": entry.url, "icon": pkg.icon},
            expires_on=o.available_to,
        ), ctx.started)
    sc = entry.scoring
    if sc and ctx.settings["ratings"].get("justwatch_scores", True):
        if sc.imdb_score and entry.imdb_id and not ctx.settings["ratings"].get("imdb_dataset", True):
            # the official IMDb dataset is fresher; JustWatch only fills the gap until it runs
            await store.set_rating(tid, "imdb", sc.imdb_score * 10, f"{sc.imdb_score:.1f}", sc.imdb_votes,
                                   f"https://www.imdb.com/title/{entry.imdb_id}/",
                                   only_if_missing=ctx.settings["ratings"].get("imdb_dataset", True))
        if sc.tmdb_score:
            # JustWatch scores only fill gaps; dedicated sources (TMDB API, OMDb, MDBList) win
            await store.set_rating(tid, "tmdb", sc.tmdb_score * 10, f"{sc.tmdb_score:.1f}", only_if_missing=True)
        if sc.tomatometer is not None:
            await store.set_rating(tid, "rottentomatoes", sc.tomatometer, f"{sc.tomatometer} %", only_if_missing=True)
    ctx.items += 1


async def sync(ctx: SyncContext) -> None:
    cfg = ctx.settings["justwatch"]
    if not cfg.get("providers"):
        ctx.note("Nejsou vybraní žádní poskytovatelé.")
        return
    delay = float(cfg.get("request_delay_s", 1.0))
    packages = {p["short_name"]: p["name"] for p in await list_providers(ctx.settings["country"])}
    selected = {sn: packages.get(sn, sn) for sn in cfg["providers"]}

    seen: set[str] = set()
    total = len(selected)
    slots = total * 2  # every provider × (films, series) is one equal share of the progress
    for idx, (provider, pname) in enumerate(selected.items(), 1):
        for t_idx, otype in enumerate(("MOVIE", "SHOW")):
            base = ((idx - 1) * 2 + t_idx) / slots
            wins = _windows()
            queue = [(lo, hi, 1 / len(wins)) for lo, hi in wins]
            done = 0.0
            while queue:
                lo, hi, w = queue.pop(0)
                kind = "filmy" if otype == "MOVIE" else "seriály"
                ctx.progress(f"{pname} ({idx}/{total}): {kind} {lo}–{hi}", base + done / slots)
                entries, capped = await _fetch_window(ctx, provider, otype, lo, hi, delay)
                if capped and hi > lo:
                    mid = (lo + hi) // 2
                    queue[:0] = [(lo, mid, w / 2), (mid + 1, hi, w / 2)]
                    continue
                done += w
                if capped:
                    ctx.partial = True
                    ctx.note(f"{pname} {otype} {lo}: víc než {CAP} titulů, část chybí.")
                for e in entries:
                    if e.entry_id in seen:
                        continue
                    seen.add(e.entry_id)
                    await _store_entry(ctx, e, selected)
        ctx.note(f"{pname}: hotovo ({len(seen)} titulů celkem).")

    if not ctx.partial:
        removed = await store.remove_stale(SOURCE, ctx.started)
        ctx.note(f"Odstraněno {removed} neaktuálních nabídek.")
