"""JustWatch (unofficial GraphQL via simple-justwatch-python-api).

Lists the whole catalogue of each selected provider, in the user's order of the services (their
priority) and newest titles first. JustWatch returns at most 1999 titles per query, so the
catalogue is walked in release-year windows per object type; a window that hits the cap is split
in half. Finished windows are recorded, so an interrupted run continues where it stopped.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import time

from simplejustwatchapi import justwatch as jw

from .. import store
from ..queries import jw_providers
from ..db import db
from ..quality import justwatch_tech, langs, provider_key, quality_from_label
from .base import SourceError, SyncContext

SOURCE = "justwatch"
PAGE = 50
CAP = 1999
KEEP_MONETIZATION = {"FLATRATE": "flatrate", "FREE": "free", "ADS": "ads", "FAST": "free"}


RESUME_KEY = "jw.resume"
RESUME_MAX_AGE_S = 48 * 3600     # an older unfinished run is started again (its data would be stale)
MAX_FAILED_WINDOWS = 3
PARALLEL = 3                     # services fetched at the same time
RETRY_SCALE = 1.0                # tests make the pauses between retries short           # this many unreachable windows in a row: the network is gone, stop


# The offers are asked for the date JustWatch recorded them (dateCreated: the day the title came to the
# service). The library has no such field: its popular query gets it added, and the dates are read from
# the raw answer by offer id. If JustWatch ever rejects the field, the catalogue is fetched without it.
_OFFER_DATES: dict[str, str] = {}
_dates = {"on": True}
_post = jw._post_to_jw_graphql_api


def _with_dates(prepare):
    def prepare_with_dates(*a, **kw):
        req = prepare(*a, **kw)
        if _dates["on"]:
            req = dict(req, query=req["query"].replace("availableTo\n", "availableTo\n    dateCreated\n", 1))
        return req
    return prepare_with_dates


def _collect_dates(node) -> None:
    if isinstance(node, dict):
        if node.get("__typename") == "Offer" and node.get("id") and node.get("dateCreated"):
            _OFFER_DATES[node["id"]] = str(node["dateCreated"])[:19]
        for v in node.values():
            _collect_dates(v)
    elif isinstance(node, list):
        for v in node:
            _collect_dates(v)


def _post_with_dates(request_json: dict) -> dict:
    res = _post(request_json)
    errors = res.get("errors") if isinstance(res, dict) else None
    if errors and "dateCreated" in str(errors) and "dateCreated" in request_json.get("query", ""):
        _dates["on"] = False                               # a field JustWatch does not know: ask without it
        res = _post(dict(request_json, query=request_json["query"].replace("    dateCreated\n", "", 1)))
    _collect_dates(res)
    return res


jw.prepare_popular_request = _with_dates(jw.prepare_popular_request)
jw.prepare_details_request = _with_dates(jw.prepare_details_request)     # the refresh button
jw.prepare_search_request = _with_dates(jw.prepare_search_request)
jw._post_to_jw_graphql_api = _post_with_dates


def _windows() -> list[tuple[int, int]]:
    """Newest first: the titles people look for arrive first."""
    year = dt.date.today().year
    return [(y, y) for y in range(year + 2, 2023, -1)] + [
        (2022, 2023), (2019, 2021), (2015, 2018), (2010, 2014), (2000, 2009), (1990, 1999), (1970, 1989), (1900, 1969)]


async def resume_pending() -> dict | None:
    """The checkpoint of an unfinished run, if it can still be continued."""
    state = await db.kv_get(RESUME_KEY)
    if not state or time.time() - state.get("started", 0) > RESUME_MAX_AGE_S:
        return None
    return state


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
    icons = await db.kv_get("jw.provider_icons", {})
    icons.update({provider_key(p["technical_name"] or p["name"]): p["icon"] for p in out if p["icon"]})
    await db.kv_set("jw.provider_icons", icons)
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
        for pause in (3, 10, 20, 40, None):
            try:
                batch = await _popular(s["country"], s["language"], count, offset, provider, lo, hi, otype)
                break
            except Exception as e:  # noqa: BLE001  - JustWatch errors and dropped connections alike
                if pause is None:
                    raise SourceError(f"JustWatch: {type(e).__name__}: {e}") from e
                await asyncio.sleep(RETRY_SCALE * pause)
        await asyncio.sleep(delay)
        results.extend(batch)
        if len(batch) < count:
            return results, False
        offset += count


async def _store_entry(ctx: SyncContext, entry, selected: dict[str, str]) -> int:
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
            added_at=_OFFER_DATES.pop(o.id, None),
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
    return tid


async def refresh_title(title: dict, ctx: SyncContext) -> None:
    """One title again: its JustWatch entry now (by its JustWatch id, else found by name), offers on the
    selected services added, changed and removed."""
    s = ctx.settings
    selected = {sn: sn for sn in jw_providers(s["justwatch"].get("providers"))}
    entry = None
    if title["ids"].get("jw"):
        try:
            entry = await asyncio.to_thread(jw.details, title["ids"]["jw"], s["country"], s["language"], True)
        except Exception:  # noqa: BLE001 - an id JustWatch no longer knows: look the title up by name
            entry = None
    if entry is None:
        otype = "MOVIE" if title["type"] == "movie" else "SHOW"
        for q in dict.fromkeys(n for n in (title["title"], title["original_title"]) if n):
            try:
                found = await asyncio.to_thread(jw.search, q, s["country"], s["language"], 10, True)
            except Exception as e:  # noqa: BLE001
                raise SourceError(f"JustWatch: {type(e).__name__}: {e}") from e
            ids_of = lambda e: {"imdb": e.imdb_id, ("tmdb_movie" if otype == "MOVIE" else "tmdb_tv"): e.tmdb_id}
            entry = next((e for e in found if e.object_type == otype
                          and store.same_work(title, e.title, None, e.release_year, ids_of(e))), None)
            if entry:
                break
    if entry is None:               # no longer on JustWatch (the search itself answered)
        await store.remove_stale_title(title["id"], SOURCE, ctx.started)
        return
    tid = await _store_entry(ctx, entry, selected)
    for t in {tid, title["id"]}:
        await store.remove_stale_title(t, SOURCE, ctx.started)


async def sync(ctx: SyncContext) -> None:
    cfg = ctx.settings["justwatch"]
    wanted = jw_providers(cfg.get("providers"))   # iVysílání and own servers have their own sources
    if not wanted:
        ctx.note("Nejsou vybraní žádní poskytovatelé.")
        return
    delay = float(cfg.get("request_delay_s", 1.0))
    packages = {p["short_name"]: p["name"] for p in await list_providers(ctx.settings["country"])}
    selected = {sn: packages.get(sn, sn) for sn in wanted}

    # continue an interrupted run of the same country and language; done windows are not fetched again
    scope = f"{ctx.settings['country']}|{ctx.settings['language']}"
    state = await resume_pending()
    if state and state.get("scope") == scope:
        ctx.note(f"Navazuji na přerušené stahování ({len(state['done'])} hotových částí).")
    else:
        state = {"scope": scope, "started": ctx.started, "done": [], "split": []}
        await db.kv_set(RESUME_KEY, state)
    done_keys, split_keys = set(state["done"]), set(state["split"])

    async def mark(kind: str, key: str) -> None:
        (done_keys if kind == "done" else split_keys).add(key)
        state[kind].append(key)
        await db.kv_set(RESUME_KEY, state)

    # several services are fetched at the same time (each with its own pause between requests); they start
    # in the user's order, so the most important ones are complete first
    seen: set[str] = set()
    failed = 0
    items = list(selected.items())
    share: dict[str, float] = {}        # service -> its finished share (0–1)
    doing: dict[str, str] = {}          # service -> what it fetches right now

    def report() -> None:
        ctx.progress(" · ".join(doing.values()), sum(share.values()) / len(items))

    async def one(provider: str, pname: str) -> None:
        nonlocal failed
        failures = 0
        share[provider] = 0.0
        for t_idx, otype in enumerate(("MOVIE", "SHOW")):
            wins = _windows()
            queue = [(lo, hi, 1 / len(wins)) for lo, hi in wins]
            done = 0.0
            while queue:
                lo, hi, w = queue.pop(0)
                key = f"{provider}|{otype}|{lo}|{hi}"
                if key in done_keys:
                    done += w
                    continue
                if key in split_keys:
                    mid = (lo + hi) // 2
                    queue[:0] = [(mid + 1, hi, w / 2), (lo, mid, w / 2)]
                    continue
                kind = "filmy" if otype == "MOVIE" else "seriály"
                doing[provider] = f"{pname}: {kind} {lo}–{hi}"
                share[provider] = (t_idx + done) / 2
                report()
                try:
                    entries, capped = await _fetch_window(ctx, provider, otype, lo, hi, delay)
                    failures = 0
                except SourceError as e:
                    # one unreachable window does not throw the run away: it stays unfinished and the next
                    # run (started automatically) fetches only what is missing
                    failures += 1
                    failed += 1
                    if failures >= MAX_FAILED_WINDOWS:
                        raise SourceError(f"{e} – stahování přerušeno, příště naváže.") from e
                    ctx.partial = True
                    ctx.note(f"{pname} {kind} {lo}–{hi}: {e}")
                    done += w
                    continue
                if capped and hi > lo:
                    mid = (lo + hi) // 2
                    queue[:0] = [(mid + 1, hi, w / 2), (lo, mid, w / 2)]
                    await mark("split", key)
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
                await mark("done", key)
        share[provider] = 1.0
        doing.pop(provider, None)
        report()
        ctx.note(f"{pname}: hotovo.")

    pending = iter(items)
    errors: list[BaseException] = []

    async def worker() -> None:
        for provider, pname in pending:
            if errors:
                return
            try:
                await one(provider, pname)
            except Exception as e:  # noqa: BLE001 - the first error ends the run after the others stop
                errors.append(e)
                return

    await asyncio.gather(*(worker() for _ in range(max(1, min(PARALLEL, len(items))))))
    if errors:
        raise errors[0]
    ctx.note(f"Celkem {len(seen)} titulů.")

    if failed:
        ctx.note(f"Nestaženo {failed} částí, doplní se automaticky.")
        return
    await db.execute("DELETE FROM kv WHERE key=?", (RESUME_KEY,))
    if not ctx.partial:
        # offers not seen since the run began (including its interrupted part) have left the service
        removed = await store.remove_stale(SOURCE, state["started"])
        ctx.note(f"Odstraněno {removed} neaktuálních nabídek.")
