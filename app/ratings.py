"""Ratings: IMDb dataset, ČSFD (scraped, no API), MDBList (aggregator, optional key)."""

from __future__ import annotations

import asyncio
import gzip
import html
import io
import contextvars
import logging
import json
import os
import re
import time
from urllib.parse import quote

from . import queries, store
from . import settings as settings_mod
from .db import DATA_DIR, db
from .quality import norm
from .sources.base import SourceError, SyncContext, http_client

IMDB_RATINGS_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz"
CSFD = "https://www.csfd.cz"
CSFD_DELAY_S = 1.5
CSFD_ERROR_LIMIT = 5        # consecutive failures before the run stops
IMDB_DATASET_MAX_AGE_S = 20 * 3600
# Honest, identifiable client. ČSFD sits behind the Anubis anti-bot page, whose default
# policy challenges browser-like ("Mozilla") user agents; a scraper must not pretend to be one.
CSFD_UA = (f"Medialect/{os.environ.get('APP_VERSION', 'dev')} "
           "(self-hosted catalogue; +https://github.com/tlkounev/Medialect)")
_ANUBIS_MARKERS = ('id="anubis_challenge"', "/.within.website/x/cmd/anubis/")


# set while one title is refreshed: the per-title rating sources then rate only that title
_ONLY: contextvars.ContextVar[int | None] = contextvars.ContextVar("ratings_only", default=None)


class CsfdBlocked(SourceError):
    """ČSFD answered with its anti-bot page instead of the real one."""


# --- IMDb (official non-commercial dataset, refreshed daily by IMDb) -----
async def _imdb_dataset_file(ctx: SyncContext) -> str:
    """Local copy of IMDb's daily ratings dataset, downloaded at most once per IMDB_DATASET_MAX_AGE_S."""
    path = os.path.join(DATA_DIR, "imdb-title.ratings.tsv.gz")
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < IMDB_DATASET_MAX_AGE_S:
        return path
    ctx.progress("IMDb: stahuji dataset", 0)
    tmp = path + ".part"
    async with http_client(timeout=300) as c:
        async with c.stream("GET", IMDB_RATINGS_URL) as r:
            r.raise_for_status()
            with open(tmp, "wb") as f:
                async for chunk in r.aiter_bytes(1 << 16):
                    f.write(chunk)
    os.replace(tmp, path)
    return path


async def imdb_dataset(ctx: SyncContext) -> None:
    """Apply IMDb ratings to every title with an IMDb id.

    The dataset is cached for a day, but it is applied on every run, so titles added by
    a later sync get their rating right away instead of the next day."""
    only = _ONLY.get()
    rows = await db.fetchall("SELECT value, title_id FROM title_ids WHERE kind='imdb'"
                             + (" AND title_id=?" if only else ""), (only,) if only else ())
    wanted: dict[str, list[int]] = {}
    for r in rows:
        wanted.setdefault(r["value"], []).append(r["title_id"])
    if not wanted:
        return
    path = await _imdb_dataset_file(ctx)
    ctx.progress(f"IMDb: přiřazuji hodnocení ({len(wanted)} titulů)", 0.5)

    def parse() -> list[tuple[str, float, int]]:
        found = []
        with gzip.open(path, "rt", encoding="utf-8") as f:
            next(f, None)
            for line in f:
                tconst, _, rest = line.partition("\t")
                if tconst in wanted:
                    avg, votes = rest.rstrip("\n").split("\t")
                    found.append((tconst, float(avg), int(votes)))
        return found

    found = await asyncio.to_thread(parse)
    now = time.time()
    async with db.lock:
        for tconst, avg, votes in found:
            for tid in wanted[tconst]:
                await db.conn.execute(
                    """INSERT INTO ratings(title_id, source, value, display, votes, url, updated_at)
                       VALUES(?,?,?,?,?,?,?) ON CONFLICT(title_id, source) DO UPDATE SET
                       value=excluded.value, display=excluded.display, votes=excluded.votes,
                       url=excluded.url, updated_at=excluded.updated_at""",
                    (tid, "imdb", avg * 10, f"{avg:.1f}", votes, f"https://www.imdb.com/title/{tconst}/", now))
        await db.conn.commit()
    ctx.items += len(found)
    ctx.note(f"IMDb: {len(found)} hodnocení z {len(wanted)} titulů s IMDb ID.")


# --- ČSFD ---------------------------------------------------------------
_FILM_HREF = re.compile(r'href="/film/(\d+)-[^"/]*/(?:prehled/)?"')
_YEAR = re.compile(r"\((\d{4})\)")
_RATING = re.compile(r'class="film-rating-average[^"]*"[^>]*>\s*(\d{1,3})\s*%')
_VOTES = re.compile(r'class="ratings-list.*?class="counter"[^>]*>\s*\(?([\d\s\xa0]+)\)?', re.S)
_IMDB_LINK = re.compile(r"imdb\.com/title/(tt\d{5,10})")


_NAME = re.compile(r'class="film-title-name"[^>]*>([^<]+)<')


def _csfd_search_results(page: str) -> list[tuple[str, int | None, str]]:
    """[(csfd_id, year, name)] from the search page, in page order (films and series)."""
    out: list[tuple[str, int | None, str]] = []
    for block in re.split(r"<article", page)[1:]:
        m = _FILM_HREF.search(block)
        if not m or any(m.group(1) == o[0] for o in out):
            continue
        y = _YEAR.search(block)
        n = _NAME.search(block)
        out.append((m.group(1), int(y.group(1)) if y else None, html.unescape(n.group(1)).strip() if n else ""))
    return out


async def _csfd_get(c, url: str, **kw) -> tuple[str, str]:
    r = await c.get(url, **kw)
    if r.status_code in (403, 429, 503) or any(m in r.text for m in _ANUBIS_MARKERS):
        raise CsfdBlocked(f"ČSFD vrátil místo stránky anti-bot ověření (HTTP {r.status_code}). "
                          "Hodnocení se zkusí znovu při dalším běhu.")
    if r.status_code != 200:
        raise SourceError(f"ČSFD HTTP {r.status_code}: {url}")
    return r.text, str(r.url)


async def csfd_candidates(c, title: str, year: int | None, ttype: str = "movie") -> list[tuple[str, bool]]:
    """ČSFD ids that may be the title, best first: [(id, check)]. check = a long-running series found by its
    start year: it is the title only if the years on its page reach the title's year (the 2026 "Scrubs" is
    series 10 of "Scrubs: Doktůrci (2001–2026)" on ČSFD). Which one it is, the IMDb id on its page decides."""
    page, _ = await _csfd_get(c, f"{CSFD}/hledat/", params={"q": title})
    results = _csfd_search_results(page)
    wanted = norm(title)
    out: list[tuple[str, bool]] = []
    add = lambda cid, check: out.append((cid, check)) if cid not in [x[0] for x in out] else None
    if year:
        # the year must agree: exact (same name first), or ±1 with the same name
        for cid, y, name in results:
            if y == year and norm(name) == wanted:
                add(cid, False)
        for cid, y, _name in results:
            if y == year:
                add(cid, False)
        for cid, y, name in results:
            if y and abs(y - year) == 1 and norm(name) == wanted:
                add(cid, False)
        if ttype == "show":
            for cid, y, name in results:
                n = norm(name)
                if y and y < year and (n == wanted or n.startswith(wanted + " ")):
                    add(cid, True)
        return out
    for cid, _y, name in results:
        if norm(name) == wanted:
            add(cid, False)
    return out


async def csfd_find(c, title: str, year: int | None, ttype: str = "movie") -> tuple[str, bool] | None:
    """The best candidate (see csfd_candidates) or None."""
    found = await csfd_candidates(c, title, year, ttype)
    return found[0] if found else None


CSFD_REJECTED_KEY = "csfd.rejected"     # ["<ČSFD id>|<IMDb id>"]: that ČSFD page is not the film with that IMDb id


async def csfd_rejected(csfd_id: str, imdb: str | None) -> bool:
    return bool(imdb) and f"{csfd_id}|{imdb}" in (await db.kv_get(CSFD_REJECTED_KEY, []))


_TAG = r"(?:<[^>]+>\s*)*"
_YEARS = re.compile(rf"\(\s*{_TAG}(\d{{4}})\s*{_TAG}[–-]\s*{_TAG}(\d{{4}})?")
_ORIGIN = re.compile(r'class="origin"[^>]*>([\s\S]{0,400})')


def csfd_years(page: str) -> tuple[int, int | None] | None:
    """The years of a series on a ČSFD page: "(2001–2026)" or "(2019– )" in the header's origin line."""
    o = _ORIGIN.search(page)
    m = _YEARS.search(o.group(1) if o else page) or _YEARS.search(page)
    return (int(m.group(1)), int(m.group(2)) if m.group(2) else None) if m else None


def csfd_film_year(page: str) -> int | None:
    """The year of a film on a ČSFD page (header's origin line: "USA, 2026, 172 min")."""
    o = _ORIGIN.search(page)
    m = re.search(r"\b(1[89]\d\d|20\d\d)\b", re.sub(r"<[^>]+>", " ", o.group(1))) if o else None
    return int(m.group(1)) if m else None


async def csfd_rating(c, csfd_id: str) -> tuple:
    """(rating %, votes, url, IMDb id linked from the page, series years, film year)."""
    page, url = await _csfd_get(c, f"{CSFD}/film/{csfd_id}/prehled/")
    if 'class="film-rating-average' not in page and "film-header" not in page:
        raise SourceError(f"ČSFD: neočekávaná stránka filmu {csfd_id}")
    m = _RATING.search(page)
    v = _VOTES.search(page)
    votes = int(re.sub(r"\D", "", v.group(1))) if v and re.sub(r"\D", "", v.group(1)) else None
    imdb = _IMDB_LINK.search(page)
    return ((int(m.group(1)) if m else None), votes, url, (imdb.group(1) if imdb else None), csfd_years(page),
            csfd_film_year(page))


CSFD_FOCUS_KEY = "ratings.focus"     # titles the user has on screen right now: rated before the rest


async def csfd_rate_row(c, row) -> None:
    """Find and store the ČSFD rating of one title (a row of _csfd_queue).

    The stored ČSFD id (from the library or an earlier search) is checked first, then the search results.
    The IMDb id on the ČSFD page decides between films of one name and year: a page with another film's
    IMDb id is never taken (and remembered as wrong); a page without any IMDb link is taken only if no
    candidate's page has the title's own IMDb id. At most 3 film pages per title."""
    if row["lib_csfd"]:
        # the user's library (an Emby ČSFD plugin) named the page: exactly that one, no search, no check
        value, votes, url, *_ = await csfd_rating(c, row["lib_csfd"])
        if row["csfd_id"] != row["lib_csfd"]:
            await db.execute("DELETE FROM title_ids WHERE title_id=? AND kind='csfd'", (row["id"],))
            await store.add_title_id(row["id"], "csfd", row["lib_csfd"])
        await store.set_rating(row["id"], "csfd", value, f"{value} %" if value is not None else None, votes, url)
        return
    have_imdb = row["imdb_id"]
    cands = [(row["csfd_id"], False, True)] if row["csfd_id"] else []
    no_link: list[tuple[str, bool]] = []

    async def reject(cid: str, stored: bool) -> None:
        """That ČSFD page is not this title: never again (the library's ČSFD id included)."""
        if have_imdb:
            rejected = await db.kv_get(CSFD_REJECTED_KEY, [])
            if f"{cid}|{have_imdb}" not in rejected:
                await db.kv_set(CSFD_REJECTED_KEY, (rejected + [f"{cid}|{have_imdb}"])[-2000:])
        if stored:
            await db.execute("DELETE FROM title_ids WHERE title_id=? AND kind='csfd' AND value=?", (row["id"], cid))
    searched, tries, hit, fallback = False, 0, None, None
    i = 0
    while tries < 3:
        if i >= len(cands):
            if searched:
                break
            searched = True
            for name in dict.fromkeys(n for n in (row["title"], row["original_title"]) if n):
                found = await csfd_candidates(c, name, row["year"], row["type"])
                await asyncio.sleep(CSFD_DELAY_S)
                if found:
                    known = {x[0] for x in cands}
                    cands += [(cid, chk, False) for cid, chk in found if cid not in known]
                    break
            continue
        cid, check, stored = cands[i]
        i += 1
        if await csfd_rejected(cid, have_imdb):
            if stored:
                await db.execute("DELETE FROM title_ids WHERE title_id=? AND kind='csfd'", (row["id"],))
            continue
        if tries:
            await asyncio.sleep(CSFD_DELAY_S)
        tries += 1
        value, votes, url, imdb, years, film_year = await csfd_rating(c, cid)
        if check and not (years and years[0] <= row["year"] <= (years[1] or 9999)):
            continue                         # a series of that name, not running that year
        if (row["type"] == "movie" and not years and film_year and row["year"]
                and abs(film_year - row["year"]) > 1):
            await reject(cid, stored)        # another film of that name (another year)
            continue
        found_hit = (cid, check, stored, value, votes, url, imdb)
        if have_imdb and imdb and imdb != have_imdb:
            await reject(cid, stored)
            continue
        if have_imdb and not imdb:
            no_link.append((cid, stored))
            fallback = fallback or found_hit     # cannot tell: a page with the title's own IMDb id wins
            continue
        hit = found_hit
        break
    if hit and hit[6]:
        for cid, stored in no_link:         # the page with the title's IMDb id won: these are other films
            await reject(cid, stored)
    hit = hit or fallback
    if not hit:
        await store.set_rating(row["id"], "csfd", None, None)  # really not on ČSFD (valid search page)
        return
    cid, check, stored, value, votes, url, imdb = hit
    if not stored:
        await db.execute("DELETE FROM title_ids WHERE title_id=? AND kind='csfd'", (row["id"],))
        await store.add_title_id(row["id"], "csfd", cid)
    await store.set_rating(row["id"], "csfd", value, f"{value} %" if value is not None else None, votes, url)
    # the IMDb id of a whole long-running series is not attached to a later revival
    if imdb and not check and not await db.fetchone(
            "SELECT 1 FROM title_ids WHERE title_id=? AND kind='imdb'", (row["id"],)):
        await store.add_title_id(row["id"], "imdb", imdb)  # lets the IMDb dataset rate it too


async def csfd_refresh_title(title_id: int) -> str | None:
    """The user asked for this title's ratings again: its ČSFD rating now (None = done, else why not)."""
    s = await settings_mod.load()
    if not s["ratings"].get("csfd"):
        return None
    rows = await db.fetchall(
        """SELECT t.id, t.type, t.title, t.original_title, t.year,
                  (SELECT value FROM title_ids i WHERE i.title_id=t.id AND i.kind='csfd') AS csfd_id,
                  (SELECT value FROM title_ids i WHERE i.title_id=t.id AND i.kind='csfd_lib') AS lib_csfd,
                  (SELECT value FROM title_ids i WHERE i.title_id=t.id AND i.kind='imdb') AS imdb_id
           FROM titles t WHERE t.id=?""", (title_id,))
    if not rows:
        return None
    try:
        async with http_client(headers={"User-Agent": CSFD_UA, "Accept-Language": "cs,en;q=0.5"}) as c:
            await csfd_rate_row(c, rows[0])
    except (CsfdBlocked, SourceError) as e:
        return str(e)
    except Exception as e:  # network down, ČSFD unreachable: the card still comes back
        logging.getLogger("medialect").warning("csfd refresh %s: %s", title_id, e)
        return f"ČSFD: {type(e).__name__}"
    return None


async def refresh_title(title_id: int, settings: dict) -> list[str]:
    """The refresh button: every rating source for this one title now (what failed, for the user)."""
    cfg = settings["ratings"]
    notes: list[str] = []
    await db.execute("UPDATE ratings SET updated_at=0 WHERE title_id=?", (title_id,))
    ctx = SyncContext(source="refresh", settings=settings)
    token = _ONLY.set(title_id)
    try:
        for name, fn, on in (("IMDb", imdb_dataset, cfg.get("imdb_dataset", True)),
                             ("MDBList", mdblist, cfg.get("mdblist_api_key")),
                             ("TMDB", tmdb, cfg.get("tmdb_api_key")), ("TVmaze", tvmaze, cfg.get("tvmaze", True)),
                             ("OMDb", omdb, cfg.get("omdb_api_key"))):
            if not on:
                continue
            try:
                await fn(ctx)
            except SourceError as e:
                notes.append(str(e))
            except Exception as e:  # noqa: BLE001 - one broken source must not stop the others
                notes.append(f"{name}: {type(e).__name__}")
    finally:
        _ONLY.reset(token)
    note = await csfd_refresh_title(title_id)
    if note:
        notes.append(note)
    return notes


async def _csfd_queue(refresh: float) -> list:
    """Titles still to be rated: the ones on the user's screen first, then the user's service order."""
    rank, rank_params = await queries.rank_sql()
    focus = json.dumps((await db.kv_get(CSFD_FOCUS_KEY, {})).get("ids") or [])
    return await db.fetchall(
        """SELECT t.id, t.type, t.title, t.original_title, t.year,
                  (SELECT value FROM title_ids i WHERE i.title_id=t.id AND i.kind='csfd') AS csfd_id,
                  (SELECT value FROM title_ids i WHERE i.title_id=t.id AND i.kind='csfd_lib') AS lib_csfd,
                  (SELECT value FROM title_ids i WHERE i.title_id=t.id AND i.kind='imdb') AS imdb_id
           FROM titles t LEFT JOIN ratings r ON r.title_id=t.id AND r.source='csfd'
           WHERE EXISTS (SELECT 1 FROM availability a WHERE a.title_id=t.id)
             AND (r.updated_at IS NULL OR r.updated_at < ?)
           ORDER BY COALESCE((SELECT CAST(j.key AS INTEGER) FROM json_each(?) j WHERE j.value = t.id), 1000000),
                    r.updated_at IS NOT NULL, {rank}, csfd_id IS NULL, r.updated_at, t.id""".format(rank=rank),
        (refresh, focus, *rank_params))


async def csfd(ctx: SyncContext) -> None:
    cfg = ctx.settings["ratings"]
    if not await db.kv_get("migrate.csfd_series_v1", False):
        # revivals of long-running series were "not found" before: search those series again
        await db.execute("DELETE FROM ratings WHERE source='csfd' AND value IS NULL AND url IS NULL "
                         "AND title_id IN (SELECT id FROM titles WHERE type='show')")
        await db.kv_set("migrate.csfd_series_v1", True)
    if not await db.kv_get("migrate.csfd_imdb_v2", False):
        # ČSFD pages are now checked against the title's IMDb id: rate again the titles where a film of the
        # same name could have been taken (the library's and titles sharing a name with another title)
        await db.execute("DELETE FROM ratings WHERE source='csfd' AND title_id IN (SELECT a.title_id FROM availability a WHERE a.kind='library' UNION SELECT n.title_id FROM title_names n WHERE n.norm IN (SELECT norm FROM title_names GROUP BY norm HAVING COUNT(DISTINCT title_id) > 1))")
        await db.kv_set("migrate.csfd_imdb_v2", True)
    refresh = time.time() - float(cfg.get("refresh_days", 14)) * 86400
    rows = await _csfd_queue(refresh)
    if not rows:
        return
    # progress over the whole catalogue: a run that continues an interrupted one starts where it stopped
    total = (await db.fetchone("SELECT COUNT(*) AS n FROM titles t WHERE EXISTS "
                               "(SELECT 1 FROM availability a WHERE a.title_id=t.id)"))["n"]
    done_before = max(0, total - len(rows))
    focus_v = (await db.kv_get(CSFD_FOCUS_KEY, {})).get("v")
    budget = int(cfg.get("csfd_daily_budget", 0))   # 0 = no daily limit, only the pause between requests
    errors = 0
    async with http_client(headers={"User-Agent": CSFD_UA, "Accept-Language": "cs,en;q=0.5"}) as c:
        i, seen = 0, set()
        while rows:
            # the user scrolled to other titles: those come next
            if (await db.kv_get(CSFD_FOCUS_KEY, {})).get("v") != focus_v:
                focus_v = (await db.kv_get(CSFD_FOCUS_KEY, {})).get("v")
                rows = [r for r in await _csfd_queue(refresh) if r["id"] not in seen]
                if not rows:
                    break
            row = rows.pop(0)
            seen.add(row["id"])
            i += 1
            ctx.progress(f"ČSFD: {done_before + i}/{total}" + (f" (denní limit {budget})" if budget else ""),
                         (done_before + i) / max(1, total))
            if not await db.budget_take("csfd", budget):
                ctx.partial = True
                ctx.note(f"ČSFD: denní limit {budget} titulů vyčerpán, pokračuje se zítra.")
                return
            try:
                await csfd_rate_row(c, row)
                ctx.items += 1
                errors = 0
            except CsfdBlocked as e:
                ctx.partial = True
                ctx.note(str(e))
                return
            except SourceError as e:
                errors += 1
                ctx.note(str(e))
                if errors >= CSFD_ERROR_LIMIT:
                    ctx.partial = True
                    ctx.note("ČSFD: příliš mnoho chyb za sebou, běh přerušen.")
                    return
            await asyncio.sleep(CSFD_DELAY_S)


# --- MDBList -------------------------------------------------------------
_MDB_SOURCES = {
    "tomatoes": "rottentomatoes", "tomatoesaudience": "rottentomatoes_audience", "popcorn": "rottentomatoes_audience",
    "metacritic": "metacritic", "metacriticuser": "metacritic_user", "letterboxd": "letterboxd",
    "trakt": "trakt", "rogerebert": "rogerebert", "myanimelist": "myanimelist",
}


async def _mdblist_get(c, key: str, imdb: str, ttype: str) -> dict | None:
    media = "movie" if ttype == "movie" else "show"
    r = await c.get(f"https://api.mdblist.com/imdb/{media}/{imdb}", params={"apikey": key})
    if r.status_code == 404:
        r = await c.get("https://mdblist.com/api/", params={"apikey": key, "i": imdb})
    if r.status_code == 429:
        raise SourceError("MDBList 429")
    if r.status_code >= 400:
        return None
    data = r.json()
    return data if isinstance(data, dict) and data.get("ratings") is not None else None


async def mdblist(ctx: SyncContext) -> None:
    cfg = ctx.settings["ratings"]
    key = cfg.get("mdblist_api_key")
    if not key:
        return
    refresh = time.time() - float(cfg.get("refresh_days", 14)) * 86400
    rank, rank_params = await queries.rank_sql()      # in the user's service order
    rows = await db.fetchall(
        """SELECT t.id, t.type, i.value AS imdb FROM titles t
           JOIN title_ids i ON i.title_id=t.id AND i.kind='imdb'
           LEFT JOIN ratings r ON r.title_id=t.id AND r.source='mdblist'
           WHERE EXISTS (SELECT 1 FROM availability a WHERE a.title_id=t.id)
             AND (r.updated_at IS NULL OR r.updated_at < ?) AND (? IS NULL OR t.id=?)
           ORDER BY r.updated_at IS NOT NULL, {rank}, r.updated_at""".format(rank=rank),
        (refresh, _ONLY.get(), _ONLY.get(), *rank_params))
    budget = int(cfg.get("mdblist_daily_budget", 900))
    async with http_client() as c:
        for i, row in enumerate(rows, 1):
            ctx.progress(f"MDBList: {i}/{len(rows)}", i / max(1, len(rows)))
            if not await db.budget_take("mdblist", budget):
                ctx.partial = True
                ctx.note("MDBList: denní limit vyčerpán.")
                return
            try:
                data = await _mdblist_get(c, key, row["imdb"], row["type"])
            except SourceError:
                ctx.partial = True
                ctx.note("MDBList: limit API (429).")
                return
            if not data:
                await store.set_rating(row["id"], "mdblist", None, None)
                continue
            for rt in data.get("ratings") or []:
                src = _MDB_SOURCES.get((rt.get("source") or "").lower())
                if not src or rt.get("value") in (None, 0):
                    continue
                score = rt.get("score")
                display = str(rt["value"]) + (" %" if src.startswith(("rottentomatoes", "metacritic")) else "")
                await store.set_rating(row["id"], src, float(score) if score is not None else None,
                                       display, rt.get("votes"), rt.get("url"))
            s = data.get("score")
            await store.set_rating(row["id"], "mdblist", float(s) if s else None, str(s) if s else None,
                                   url=f"https://mdblist.com/?q={quote(row['imdb'])}")
            ctx.items += 1
            await asyncio.sleep(0.2)



# --- shared helper for per-title rating sources -----------------------------
async def _due(source: str, refresh_days: float, kinds: tuple[str, ...], ttype: str | None = None) -> list:
    """Titles in the catalogue that have one of the id kinds and no fresh `source` rating."""
    refresh = time.time() - refresh_days * 86400
    sql = (f"""SELECT t.id, t.type,
                  (SELECT value FROM title_ids i WHERE i.title_id=t.id AND i.kind='imdb') AS imdb,
                  (SELECT value FROM title_ids i WHERE i.title_id=t.id AND i.kind='tvdb') AS tvdb,
                  (SELECT value FROM title_ids i WHERE i.title_id=t.id AND i.kind='tmdb_movie') AS tmdb_movie,
                  (SELECT value FROM title_ids i WHERE i.title_id=t.id AND i.kind='tmdb_tv') AS tmdb_tv
           FROM titles t LEFT JOIN ratings r ON r.title_id=t.id AND r.source=?
           WHERE EXISTS (SELECT 1 FROM availability a WHERE a.title_id=t.id)
             AND EXISTS (SELECT 1 FROM title_ids i WHERE i.title_id=t.id AND i.kind IN ({','.join('?' * len(kinds))}))
             AND (r.updated_at IS NULL OR r.updated_at < ?)""")
    params: list = [source, *kinds, refresh]
    if ttype:
        sql += " AND t.type=?"
        params.append(ttype)
    if _ONLY.get():
        sql += " AND t.id=?"
        params.append(_ONLY.get())
    rank, rank_params = await queries.rank_sql()      # in the user's service order
    sql += f" ORDER BY r.updated_at IS NOT NULL, {rank}, r.updated_at, t.id"
    return await db.fetchall(sql, [*params, *rank_params])


# --- TMDB (free API key) ------------------------------------------------------
TMDB_API = "https://api.themoviedb.org/3"


def _tmdb_auth(key: str) -> tuple[dict, dict]:
    if key.startswith("eyJ"):            # v4 read access token
        return {"Authorization": f"Bearer {key}"}, {}
    return {}, {"api_key": key}


async def tmdb(ctx: SyncContext) -> None:
    cfg = ctx.settings["ratings"]
    key = cfg.get("tmdb_api_key")
    if not key:
        return
    rows = await _due("tmdb_api", float(cfg.get("refresh_days", 14)), ("tmdb_movie", "tmdb_tv", "imdb"))
    headers, auth = _tmdb_auth(key)
    async with http_client(headers=headers) as c:
        for i, row in enumerate(rows, 1):
            ctx.progress(f"TMDB: {i}/{len(rows)}", i / max(1, len(rows)))
            kind = "movie" if row["type"] == "movie" else "tv"
            tmdb_id = row["tmdb_movie"] if kind == "movie" else row["tmdb_tv"]
            if not tmdb_id and row["imdb"]:
                r = await c.get(f"{TMDB_API}/find/{row['imdb']}", params={**auth, "external_source": "imdb_id"})
                if r.status_code == 401:
                    raise SourceError("TMDB: neplatný API klíč.")
                hits = (r.json().get("movie_results" if kind == "movie" else "tv_results") or []) if r.status_code == 200 else []
                if hits:
                    tmdb_id = str(hits[0]["id"])
                    await store.add_title_id(row["id"], f"tmdb_{kind if kind == 'movie' else 'tv'}", tmdb_id)
            if not tmdb_id:
                await store.set_rating(row["id"], "tmdb_api", None, None)
                continue
            r = await c.get(f"{TMDB_API}/{kind}/{tmdb_id}", params=auth)
            if r.status_code == 401:
                raise SourceError("TMDB: neplatný API klíč.")
            if r.status_code == 429:
                await asyncio.sleep(10)
                continue
            if r.status_code == 200:
                d = r.json()
                avg, votes = d.get("vote_average"), d.get("vote_count")
                if avg and votes:
                    await store.set_rating(row["id"], "tmdb", avg * 10, f"{avg:.1f}", votes,
                                           f"https://www.themoviedb.org/{kind}/{tmdb_id}")
                    ctx.items += 1
            await store.set_rating(row["id"], "tmdb_api", None, None)   # marker: checked now
            await asyncio.sleep(0.15)


# --- TVmaze (free, no key, series only) ---------------------------------------
TVMAZE_API = "https://api.tvmaze.com"


async def tvmaze(ctx: SyncContext) -> None:
    cfg = ctx.settings["ratings"]
    rows = await _due("tvmaze", float(cfg.get("refresh_days", 14)), ("imdb", "tvdb"), ttype="show")
    async with http_client() as c:
        for i, row in enumerate(rows, 1):
            ctx.progress(f"TVmaze: {i}/{len(rows)}", i / max(1, len(rows)))
            show = None
            for param, value in (("imdb", row["imdb"]), ("thetvdb", row["tvdb"])):
                if not value:
                    continue
                r = await c.get(f"{TVMAZE_API}/lookup/shows", params={param: value})
                if r.status_code == 429:
                    await asyncio.sleep(10)
                    r = await c.get(f"{TVMAZE_API}/lookup/shows", params={param: value})
                await asyncio.sleep(0.6)            # TVmaze allows 20 calls per 10 s
                if r.status_code == 200:
                    show = r.json()
                    break
            avg = ((show or {}).get("rating") or {}).get("average")
            if avg:
                await store.set_rating(row["id"], "tvmaze", avg * 10, f"{avg:.1f}", None, show.get("url"))
                ctx.items += 1
            else:
                await store.set_rating(row["id"], "tvmaze", None, None)


# --- OMDb (free key, 1000 requests/day): relays IMDb, Rotten Tomatoes, Metacritic --
OMDB_API = "https://www.omdbapi.com/"

async def omdb(ctx: SyncContext) -> None:
    cfg = ctx.settings["ratings"]
    key = cfg.get("omdb_api_key")
    if not key:
        return
    rows = await _due("omdb", float(cfg.get("refresh_days", 14)), ("imdb",))
    budget = int(cfg.get("omdb_daily_budget", 950))
    async with http_client() as c:
        for i, row in enumerate(rows, 1):
            ctx.progress(f"OMDb: {i}/{len(rows)}", i / max(1, len(rows)))
            if not await db.budget_take("omdb", budget):
                ctx.partial = True
                ctx.note(f"OMDb: denní limit {budget} dotazů vyčerpán, pokračuje se zítra.")
                return
            r = await c.get(OMDB_API, params={"apikey": key, "i": row["imdb"]})
            if r.status_code == 401:
                raise SourceError("OMDb: neplatný API klíč nebo vyčerpaný limit.")
            d = r.json() if r.status_code == 200 else {}
            if d.get("Response") == "False" and "limit" in (d.get("Error") or "").lower():
                ctx.partial = True
                ctx.note("OMDb: limit API vyčerpán.")
                return
            for rt in d.get("Ratings") or []:
                src, val = rt.get("Source"), rt.get("Value") or ""
                if src == "Rotten Tomatoes" and val.endswith("%"):
                    await store.set_rating(row["id"], "rottentomatoes", float(val[:-1]), val.replace("%", " %"))
                elif src == "Metacritic" and "/" in val:
                    score = val.split("/")[0]
                    await store.set_rating(row["id"], "metacritic", float(score), f"{score}/100")
            await store.set_rating(row["id"], "omdb", None, None)        # marker: checked now
            ctx.items += 1
            await asyncio.sleep(0.25)


async def sync(ctx: SyncContext) -> None:
    cfg = ctx.settings["ratings"]
    if await db.kv_get("migrate.csfd_reset_v2") is None:
        # v1.0.0–1.0.3 stored ČSFD's anti-bot page as "not found / no rating": forget those results
        await db.execute("DELETE FROM ratings WHERE source='csfd' AND value IS NULL")
        await db.kv_set("migrate.csfd_reset_v2", True)
    guarded = [(name, fn) for name, fn, on in (
        ("TMDB", tmdb, cfg.get("tmdb_api_key")), ("TVmaze", tvmaze, cfg.get("tvmaze", True)),
        ("OMDb", omdb, cfg.get("omdb_api_key"))) if on]
    n = (bool(cfg.get("imdb_dataset", True)) + bool(cfg.get("mdblist_api_key")) + len(guarded)
         + bool(cfg.get("csfd", True)) * (1 + bool(cfg.get("imdb_dataset", True))))
    k = 0

    def next_step() -> None:
        nonlocal k
        ctx.step(k, max(1, n))
        k += 1

    if cfg.get("imdb_dataset", True):
        next_step()
        await imdb_dataset(ctx)
    if cfg.get("mdblist_api_key"):
        next_step()
        await mdblist(ctx)
    for name, fn in guarded:
        next_step()
        try:
            await fn(ctx)
        except SourceError as e:            # one broken source must not stop the others
            ctx.partial = True
            ctx.note(str(e))
        except Exception as e:  # noqa: BLE001
            ctx.partial = True
            ctx.note(f"{name}: {type(e).__name__}: {e}")
    if cfg.get("csfd", True):
        next_step()
        await csfd(ctx)
        if cfg.get("imdb_dataset", True):
            next_step()
            await imdb_dataset(ctx)   # IMDb ids found on ČSFD pages

