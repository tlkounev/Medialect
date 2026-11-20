"""Write helpers: unify titles across sources, upsert availability and ratings."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any

from .db import db
from .quality import norm


@dataclass
class TitleInfo:
    type: str                          # movie | show
    title: str
    original_title: str | None = None
    year: int | None = None
    poster: str | None = None
    ids: dict[str, str] = field(default_factory=dict)   # imdb, tmdb_movie, tmdb_tv, tvdb, csfd, jw, sa
    extra_names: list[str] = field(default_factory=list)
    # id kinds this source knows better than our own lookups (e.g. the ČSFD id an Emby plugin assigned):
    # a different stored value is replaced and the rating derived from it is fetched again
    authoritative: tuple[str, ...] = ()
    # the user's own library (Emby, Jellyfin, Plex): its IMDb/TMDB/TVDB ids are trusted over a streaming
    # catalogue entry that attached the same id to a different work, whichever of the two was read first
    library: bool = False


# a source's own entry id always means the same title
OWN_KINDS = ("jw", "sa", "ct")
# ids that name exactly one work: a title never holds two different values of one of these kinds
STRONG_KINDS = ("imdb", "tmdb_movie", "tmdb_tv", "tvdb")
YEAR_TOLERANCE = 2


def _years_clash(a: int | None, b: int | None) -> bool:
    return bool(a and b and abs(a - b) > YEAR_TOLERANCE)


# the ČSFD id the user's library assigned (an Emby ČSFD plugin): the ratings take it as it is, never search
LIBRARY_CSFD = "csfd_lib"


async def _conflict_kinds(conn, tid: int, ids: dict[str, str]) -> list[str]:
    """The strong kinds in which merging these ids into the title would give it two different values."""
    async with conn.execute("SELECT kind, value FROM title_ids WHERE title_id=?", (tid,)) as cur:
        existing: dict[str, set[str]] = {}
        for k, v in await cur.fetchall():
            existing.setdefault(k, set()).add(v)
    return [k for k, v in ids.items() if k in STRONG_KINDS and k in existing and v not in existing[k]]


async def _conflicts(conn, tid: int, ids: dict[str, str]) -> bool:
    """Would merging these ids into the title give it two different values of one strong kind?"""
    return bool(await _conflict_kinds(conn, tid, ids))


@dataclass
class Offer:
    source: str
    provider: str
    provider_name: str
    kind: str                          # stream | library
    monetization: str
    quality: str | None = None
    video: list[str] = field(default_factory=list)
    audio: list[str] = field(default_factory=list)
    audio_langs: list[str] = field(default_factory=list)
    subtitle_langs: list[str] = field(default_factory=list)
    url: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)
    expires_on: str | None = None
    added_at: str | None = None     # ISO date/time the platform or library added it


def _clean_ids(info: TitleInfo) -> dict[str, str]:
    out = {}
    for k, v in info.ids.items():
        if v in (None, "", 0, "0"):
            continue
        v = str(v).strip()
        if k == "imdb" and not v.startswith("tt"):
            continue
        out[k] = v
    return out


async def _find_title(conn, info: TitleInfo, ids: dict[str, str]) -> int | None:
    # 1) exact external id match (own entry ids first); an id shared by works years apart is a data error
    for kind, value in sorted(ids.items(), key=lambda kv: kv[0] not in OWN_KINDS):
        async with conn.execute("SELECT i.title_id, t.year FROM title_ids i JOIN titles t ON t.id=i.title_id "
                                "WHERE i.kind=? AND i.value=?", (kind, value)) as cur:
            row = await cur.fetchone()
        if not row:
            continue
        if kind in OWN_KINDS:
            # a catalogue entry joined to a title of another work (different IMDb id, e.g. a library film of
            # the same name merged by name earlier): it leaves that title, with the ratings it brought
            if "imdb" not in await _conflict_kinds(conn, row[0], ids):
                return row[0]
            await conn.execute("DELETE FROM title_ids WHERE kind=? AND value=?", (kind, value))
            await conn.execute("DELETE FROM ratings WHERE title_id=? AND source!='csfd'", (row[0],))
            continue
        # one shared id is not enough when the rest disagrees: two works of the same name must stay apart
        if not _years_clash(row[1], info.year) and not await _conflicts(conn, row[0], ids):
            return row[0]
    # 2) name + year + type, but never merge across conflicting ids
    names = {norm(n) for n in (info.title, info.original_title, *info.extra_names) if n}
    names.discard("")
    if not names or not info.year:
        return None
    q = (
        "SELECT DISTINCT t.id FROM titles t JOIN title_names n ON n.title_id=t.id "
        f"WHERE t.type=? AND t.year BETWEEN ? AND ? AND n.norm IN ({','.join('?' * len(names))}) "
        "ORDER BY ABS(t.year-?)"
    )
    async with conn.execute(q, (info.type, info.year - 1, info.year + 1, *names, info.year)) as cur:
        candidates = [r[0] for r in await cur.fetchall()]
    for tid in candidates:
        if not await _conflicts(conn, tid, ids):
            return tid
    # 3) the user's own library and a streaming catalogue often disagree in one id (e.g. TMDB) for the same
    # series: the same name, type and year (±1) on one library and one catalogue title is the same work
    # (only one id may disagree, and never the IMDb id: that one tells two films of the same name apart)
    for tid in candidates:
        if await _has_library(conn, tid) == info.library:
            continue
        clash = await _conflict_kinds(conn, tid, ids)
        if len(clash) <= 1 and "imdb" not in clash:
            return tid
    return None


async def _has_library(conn, tid: int) -> bool:
    async with conn.execute("SELECT 1 FROM availability WHERE title_id=? AND kind='library' LIMIT 1", (tid,)) as cur:
        return await cur.fetchone() is not None


async def _strong_value(conn, tid: int, kind: str) -> str | None:
    async with conn.execute("SELECT value FROM title_ids WHERE title_id=? AND kind=? LIMIT 1", (tid, kind)) as cur:
        r = await cur.fetchone()
    return r[0] if r else None


async def upsert_title(info: TitleInfo) -> int:
    ids = _clean_ids(info)
    now = time.time()
    async with db.lock:
        conn = db.conn
        tid = await _find_title(conn, info, ids)
        if tid is None:
            cur = await conn.execute(
                "INSERT INTO titles(type, title, original_title, year, poster, created_at, updated_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (info.type, info.title, info.original_title, info.year, info.poster, now, now),
            )
            tid = cur.lastrowid
        else:
            # the poster of the user's own library wins (it is the one the user chose, and stays current)
            poster_sql = "poster=COALESCE(?, poster)" if info.library else "poster=COALESCE(poster, ?)"
            await conn.execute(
                "UPDATE titles SET original_title=COALESCE(original_title, ?), year=COALESCE(year, ?), "
                f"{poster_sql}, updated_at=? WHERE id=?",
                (info.original_title, info.year, info.poster, now, tid),
            )
        for kind, value in ids.items():
            if kind in info.authoritative:
                async with conn.execute("SELECT value FROM title_ids WHERE title_id=? AND kind=?", (tid, kind)) as cur:
                    old = [r[0] for r in await cur.fetchall()]
                if kind == "csfd":
                    # the library's word is final: the ratings use exactly this page (no search, no check)
                    await conn.execute("DELETE FROM title_ids WHERE title_id=? AND kind=? AND value!=?",
                                       (tid, LIBRARY_CSFD, value))
                    await conn.execute("INSERT OR REPLACE INTO title_ids(kind, value, title_id) VALUES(?,?,?)",
                                       (LIBRARY_CSFD, value, tid))
                if old != [value]:
                    await conn.execute("DELETE FROM title_ids WHERE title_id=? AND kind=? AND value!=?", (tid, kind, value))
                    await conn.execute("INSERT OR REPLACE INTO title_ids(kind, value, title_id) VALUES(?,?,?)", (kind, value, tid))
                    if kind == "csfd":
                        await conn.execute("DELETE FROM ratings WHERE title_id=? AND source='csfd'", (tid,))
                continue
            if kind in STRONG_KINDS and (have := await _strong_value(conn, tid, kind)) not in (None, value):
                # one work has one value of a strong id: the library's own id replaces a catalogue's
                # (ratings derived from the old one are fetched again), a catalogue's never replaces one
                if not info.library:
                    continue
                await conn.execute("DELETE FROM title_ids WHERE title_id=? AND kind=?", (tid, kind))
                await conn.execute("DELETE FROM ratings WHERE title_id=? AND source!='csfd'", (tid,))
            if info.library and kind in STRONG_KINDS:
                # never from another library title: two servers that disagree must not take it from each other
                # on every run
                async with conn.execute(
                        "SELECT i.title_id FROM title_ids i WHERE i.kind=? AND i.value=? AND NOT EXISTS "
                        "(SELECT 1 FROM availability a WHERE a.title_id=i.title_id AND a.kind='library')",
                        (kind, value)) as cur:
                    owner = await cur.fetchone()
                if owner and owner[0] != tid:
                    # _find_title refused that title as a different work: the id belongs here, and the ratings
                    # the other title got through it are wrong (they are fetched again from the ids it keeps)
                    await conn.execute("UPDATE title_ids SET title_id=? WHERE kind=? AND value=?", (tid, kind, value))
                    await conn.execute("DELETE FROM ratings WHERE title_id=?", (owner[0],))
                    continue
            await conn.execute("INSERT OR IGNORE INTO title_ids(kind, value, title_id) VALUES(?,?,?)", (kind, value, tid))
        for n in {norm(x) for x in (info.title, info.original_title, *info.extra_names) if x}:
            if n:
                await conn.execute("INSERT OR IGNORE INTO title_names(title_id, norm) VALUES(?,?)", (tid, n))
        await conn.commit()
    return tid


async def upsert_offer(title_id: int, o: Offer, seen_at: float) -> None:
    await db.execute(
        """INSERT INTO availability(title_id, source, provider, provider_name, kind, monetization, quality,
               video, audio, audio_langs, subtitle_langs, url, extra, expires_on, added_at, seen_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(title_id, source, provider, monetization) DO UPDATE SET
               provider_name=excluded.provider_name, kind=excluded.kind, quality=excluded.quality,
               video=excluded.video, audio=excluded.audio, audio_langs=excluded.audio_langs,
               subtitle_langs=excluded.subtitle_langs, url=excluded.url, extra=excluded.extra,
               expires_on=excluded.expires_on, added_at=COALESCE(excluded.added_at, availability.added_at),
               seen_at=excluded.seen_at""",
        (
            title_id, o.source, o.provider, o.provider_name, o.kind, o.monetization, o.quality,
            json.dumps(o.video), json.dumps(o.audio), json.dumps(o.audio_langs), json.dumps(o.subtitle_langs),
            o.url, json.dumps(o.extra), o.expires_on, (o.added_at or "")[:19] or None, seen_at,
        ),
    )


async def remove_stale(source: str, before: float, provider: str | None = None, title_type: str | None = None) -> int:
    sql = "DELETE FROM availability WHERE source=? AND seen_at<?"
    params: list[Any] = [source, before]
    if provider:
        sql += " AND provider=?"
        params.append(provider)
    if title_type:
        sql += " AND title_id IN (SELECT id FROM titles WHERE type=?)"
        params.append(title_type)
    async with db.lock:
        cur = await db.conn.execute(sql, params)
        await db.conn.commit()
        return cur.rowcount


async def remove_stale_title(title_id: int, source: str, before: float) -> int:
    """One title refreshed from one source: its offers that source no longer lists."""
    async with db.lock:
        cur = await db.conn.execute("DELETE FROM availability WHERE title_id=? AND source=? AND seen_at<?",
                                    (title_id, source, before))
        await db.conn.commit()
        return cur.rowcount


def same_work(title: dict, name: str | None, original: str | None, year: int | None, ids: dict) -> bool:
    """Is a source's item (name, year, ids) the title being refreshed ({title, original_title, year, ids})?
    A shared strong id decides; without one, the name and the year (±1) must agree."""
    mine = title.get("ids") or {}
    shared = [k for k in STRONG_KINDS if ids.get(k) and mine.get(k)]
    if shared:
        return all(str(ids[k]) == str(mine[k]) for k in shared)
    names = {norm(x) for x in (title.get("title"), title.get("original_title")) if x}
    if not names & {norm(x) for x in (name, original) if x}:
        return False
    return not (year and title.get("year") and abs(int(year) - int(title["year"])) > 1)


async def set_rating(title_id: int, source: str, value: float | None, display: str | None,
                     votes: int | None = None, url: str | None = None, only_if_missing: bool = False) -> None:
    conflict = ("DO NOTHING" if only_if_missing else
                "DO UPDATE SET value=excluded.value, display=excluded.display, votes=excluded.votes, "
                "url=COALESCE(excluded.url, ratings.url), updated_at=excluded.updated_at")
    await db.execute(
        "INSERT INTO ratings(title_id, source, value, display, votes, url, updated_at) VALUES(?,?,?,?,?,?,?) "
        f"ON CONFLICT(title_id, source) {conflict}",
        (title_id, source, value, display, votes, url, time.time()),
    )


async def add_title_id(title_id: int, kind: str, value: str) -> None:
    await db.execute("INSERT OR IGNORE INTO title_ids(kind, value, title_id) VALUES(?,?,?)", (kind, str(value), title_id))


async def repair_mixed_titles() -> int:
    """Titles that hold two values of one strong id kind mix two works (merged before v1.0.17).

    They are dropped completely; the full synchronisation that follows creates them again, correctly
    separated. Returns how many titles were dropped."""
    rows = await db.fetchall(
        f"SELECT DISTINCT title_id FROM title_ids WHERE kind IN ({','.join('?' * len(STRONG_KINDS))}) "
        "GROUP BY title_id, kind HAVING COUNT(*) > 1", STRONG_KINDS)
    ids = [r[0] for r in rows]
    if not ids:
        return 0
    async with db.lock:
        for tid in ids:
            for table, col in (("availability", "title_id"), ("ratings", "title_id"), ("title_ids", "title_id"),
                               ("title_names", "title_id"), ("titles", "id")):
                await db.conn.execute(f"DELETE FROM {table} WHERE {col}=?", (tid,))
        await db.conn.commit()
    return len(ids)


async def merge_library_twins() -> int:
    """Merges a catalogue title into the library title of the same work (same name, type, year ±1) that
    earlier runs kept apart because one id disagreed. Returns how many titles were merged."""
    rows = await db.fetchall(
        """SELECT DISTINCT a.title_id AS lib, b.title_id AS cat
           FROM title_names a JOIN title_names b ON b.norm=a.norm AND b.title_id!=a.title_id
           JOIN titles l ON l.id=a.title_id JOIN titles c ON c.id=b.title_id
           WHERE l.type=c.type AND l.year IS NOT NULL AND c.year IS NOT NULL AND ABS(l.year-c.year) <= 1
             AND EXISTS (SELECT 1 FROM availability x WHERE x.title_id=l.id AND x.kind='library')
             AND NOT EXISTS (SELECT 1 FROM availability x WHERE x.title_id=c.id AND x.kind='library')
           ORDER BY a.title_id, b.title_id""")
    merged = 0
    async with db.lock:
        conn = db.conn
        for r in rows:
            lib, cat = r["lib"], r["cat"]
            async with conn.execute("SELECT 1 FROM titles WHERE id=?", (cat,)) as cur:
                if not await cur.fetchone():
                    continue           # already merged into another library title
            async with conn.execute("SELECT kind, value FROM title_ids WHERE title_id=?", (cat,)) as cur:
                cat_ids = list(await cur.fetchall())
            for kind, value in cat_ids:
                if kind in STRONG_KINDS and await _strong_value(conn, lib, kind) not in (None, value):
                    await conn.execute("DELETE FROM title_ids WHERE kind=? AND value=?", (kind, value))
                else:
                    await conn.execute("UPDATE OR IGNORE title_ids SET title_id=? WHERE kind=? AND value=?", (lib, kind, value))
            for table in ("availability", "title_names", "ratings"):
                await conn.execute(f"UPDATE OR IGNORE {table} SET title_id=? WHERE title_id=?", (lib, cat))
                await conn.execute(f"DELETE FROM {table} WHERE title_id=?", (cat,))
            await conn.execute("DELETE FROM title_ids WHERE title_id=?", (cat,))
            await conn.execute("UPDATE titles SET poster=COALESCE(poster, (SELECT poster FROM titles WHERE id=?)) WHERE id=?", (cat, lib))
            await conn.execute("DELETE FROM titles WHERE id=?", (cat,))
            merged += 1
        await conn.commit()
    return merged
