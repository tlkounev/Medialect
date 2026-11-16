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
OWN_KINDS = ("jw", "sa")
# ids that name exactly one work: a title never holds two different values of one of these kinds
STRONG_KINDS = ("imdb", "tmdb_movie", "tmdb_tv", "tvdb")
YEAR_TOLERANCE = 2


def _years_clash(a: int | None, b: int | None) -> bool:
    return bool(a and b and abs(a - b) > YEAR_TOLERANCE)


async def _conflicts(conn, tid: int, ids: dict[str, str]) -> bool:
    """Would merging these ids into the title give it two different values of one strong kind?"""
    async with conn.execute("SELECT kind, value FROM title_ids WHERE title_id=?", (tid,)) as cur:
        existing: dict[str, set[str]] = {}
        for k, v in await cur.fetchall():
            existing.setdefault(k, set()).add(v)
    return any(k in existing and v not in existing[k] for k, v in ids.items() if k in STRONG_KINDS)


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
            return row[0]
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
    return None


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
            await conn.execute(
                "UPDATE titles SET original_title=COALESCE(original_title, ?), year=COALESCE(year, ?), "
                "poster=COALESCE(poster, ?), updated_at=? WHERE id=?",
                (info.original_title, info.year, info.poster, now, tid),
            )
        for kind, value in ids.items():
            if kind in info.authoritative:
                async with conn.execute("SELECT value FROM title_ids WHERE title_id=? AND kind=?", (tid, kind)) as cur:
                    old = [r[0] for r in await cur.fetchall()]
                if old != [value]:
                    await conn.execute("DELETE FROM title_ids WHERE title_id=? AND kind=? AND value!=?", (tid, kind, value))
                    await conn.execute("INSERT OR REPLACE INTO title_ids(kind, value, title_id) VALUES(?,?,?)", (kind, value, tid))
                    if kind == "csfd":
                        await conn.execute("DELETE FROM ratings WHERE title_id=? AND source='csfd'", (tid,))
                continue
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
