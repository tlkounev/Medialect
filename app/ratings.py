"""Ratings: IMDb dataset, ČSFD (scraped, no API), MDBList (aggregator, optional key)."""

from __future__ import annotations

import asyncio
import gzip
import html
import io
import re
import time
from urllib.parse import quote

from . import store
from .db import db
from .quality import norm
from .sources.base import SourceError, SyncContext, http_client

IMDB_RATINGS_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz"
CSFD = "https://www.csfd.cz"
CSFD_DELAY_S = 1.5
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")


# --- IMDb (official non-commercial dataset, refreshed daily by IMDb) -----
async def imdb_dataset(ctx: SyncContext) -> None:
    last = await db.kv_get("ratings.imdb_dataset_at", 0)
    if time.time() - last < 20 * 3600:
        ctx.note("IMDb dataset je čerstvý, přeskočeno.")
        return
    ctx.progress("IMDb: stahuji dataset")
    rows = await db.fetchall("SELECT value, title_id FROM title_ids WHERE kind='imdb'")
    wanted: dict[str, list[int]] = {}
    for r in rows:
        wanted.setdefault(r["value"], []).append(r["title_id"])
    if not wanted:
        return
    async with http_client(timeout=300) as c:
        r = await c.get(IMDB_RATINGS_URL)
        r.raise_for_status()
        raw = r.content

    def parse() -> list[tuple[str, float, int]]:
        found = []
        with gzip.open(io.BytesIO(raw), "rt", encoding="utf-8") as f:
            next(f, None)
            for line in f:
                tconst, avg, votes = line.rstrip("\n").split("\t")
                if tconst in wanted:
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
    await db.kv_set("ratings.imdb_dataset_at", now)
    ctx.items += len(found)
    ctx.note(f"IMDb: aktualizováno {len(found)} hodnocení.")


# --- ČSFD ---------------------------------------------------------------
_FILM_HREF = re.compile(r'href="/film/(\d+)-[^"/]*/(?:prehled/)?"')
_YEAR = re.compile(r"\((\d{4})\)")
_RATING = re.compile(r'class="film-rating-average[^"]*"[^>]*>\s*(\d{1,3})\s*%')
_VOTES = re.compile(r"Hodnocení\s*<span[^>]*>\s*\(([\d\s\xa0]+)\)")


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


async def csfd_find(c, title: str, year: int | None) -> str | None:
    r = await c.get(f"{CSFD}/hledat/", params={"q": title})
    if r.status_code != 200:
        raise SourceError(f"ČSFD hledání HTTP {r.status_code}")
    results = _csfd_search_results(r.text)
    if not results:
        return None
    wanted = norm(title)
    if year:
        # exact year wins; a ±1 year difference is accepted only with the same name
        for cid, y, _name in results:
            if y == year:
                return cid
        for cid, y, name in results:
            if y and abs(y - year) == 1 and norm(name) == wanted:
                return cid
        return None
    for cid, _y, name in results:
        if norm(name) == wanted:
            return cid
    return None


async def csfd_rating(c, csfd_id: str) -> tuple[int | None, int | None, str]:
    r = await c.get(f"{CSFD}/film/{csfd_id}/")
    if r.status_code != 200:
        raise SourceError(f"ČSFD film HTTP {r.status_code}")
    page = r.text
    m = _RATING.search(page)
    v = _VOTES.search(page)
    votes = int(re.sub(r"\D", "", v.group(1))) if v else None
    return (int(m.group(1)) if m else None), votes, str(r.url)


async def csfd(ctx: SyncContext) -> None:
    cfg = ctx.settings["ratings"]
    refresh = time.time() - float(cfg.get("refresh_days", 14)) * 86400
    rows = await db.fetchall(
        """SELECT t.id, t.title, t.original_title, t.year,
                  (SELECT value FROM title_ids i WHERE i.title_id=t.id AND i.kind='csfd') AS csfd_id
           FROM titles t LEFT JOIN ratings r ON r.title_id=t.id AND r.source='csfd'
           WHERE EXISTS (SELECT 1 FROM availability a WHERE a.title_id=t.id)
             AND (r.updated_at IS NULL OR r.updated_at < ?)
           ORDER BY r.updated_at IS NOT NULL, csfd_id IS NULL,
                    NOT EXISTS (SELECT 1 FROM availability a WHERE a.title_id=t.id AND a.kind='library'),
                    r.updated_at, t.id""", (refresh,))
    if not rows:
        return
    budget = int(cfg.get("csfd_daily_budget", 400))
    async with http_client(headers={"User-Agent": BROWSER_UA, "Accept-Language": "cs,en;q=0.5"}) as c:
        for i, row in enumerate(rows, 1):
            ctx.progress(f"ČSFD: {i}/{len(rows)} (denní limit {budget})")
            if not await db.budget_take("csfd", budget):
                ctx.partial = True
                ctx.note("ČSFD: denní limit vyčerpán.")
                return
            try:
                cid = row["csfd_id"]
                if not cid:
                    for name in dict.fromkeys(n for n in (row["title"], row["original_title"]) if n):
                        cid = await csfd_find(c, name, row["year"])
                        await asyncio.sleep(CSFD_DELAY_S)
                        if cid:
                            await store.add_title_id(row["id"], "csfd", cid)
                            break
                if not cid:
                    await store.set_rating(row["id"], "csfd", None, None)  # remember "not found"
                    continue
                value, votes, url = await csfd_rating(c, cid)
                await store.set_rating(row["id"], "csfd", value, f"{value} %" if value is not None else None, votes, url)
                ctx.items += 1
            except SourceError as e:
                ctx.note(str(e))
                if "429" in str(e) or "403" in str(e):
                    ctx.partial = True
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
    rows = await db.fetchall(
        """SELECT t.id, t.type, i.value AS imdb FROM titles t
           JOIN title_ids i ON i.title_id=t.id AND i.kind='imdb'
           LEFT JOIN ratings r ON r.title_id=t.id AND r.source='mdblist'
           WHERE EXISTS (SELECT 1 FROM availability a WHERE a.title_id=t.id)
             AND (r.updated_at IS NULL OR r.updated_at < ?)
           ORDER BY r.updated_at IS NOT NULL, r.updated_at""", (refresh,))
    budget = int(cfg.get("mdblist_daily_budget", 900))
    async with http_client() as c:
        for i, row in enumerate(rows, 1):
            ctx.progress(f"MDBList: {i}/{len(rows)}")
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


async def sync(ctx: SyncContext) -> None:
    cfg = ctx.settings["ratings"]
    if cfg.get("imdb_dataset", True):
        await imdb_dataset(ctx)
    if cfg.get("mdblist_api_key"):
        await mdblist(ctx)
    if cfg.get("csfd", True):
        await csfd(ctx)

