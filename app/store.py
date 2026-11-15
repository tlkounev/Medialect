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
    # 1) exact external id match
    for kind, value in ids.items():
        async with conn.execute("SELECT title_id FROM title_ids WHERE kind=? AND value=?", (kind, value)) as cur:
            row = await cur.fetchone()
        if row:
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
        async with conn.execute("SELECT kind, value FROM title_ids WHERE title_id=?", (tid,)) as cur:
            existing = {r[0]: r[1] for r in await cur.fetchall()}
        conflict = any(k in existing and existing[k] != v for k, v in ids.items() if k in ("imdb", "tmdb_movie", "tmdb_tv", "tvdb"))
        if not conflict:
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
            await conn.execute("INSERT OR IGNORE INTO title_ids(kind, value, title_id) VALUES(?,?,?)", (kind, value, tid))
        for n in {norm(x) for x in (info.title, info.original_title, *info.extra_names) if x}:
            if n:
                await conn.execute("INSERT OR IGNORE INTO title_names(title_id, norm) VALUES(?,?)", (tid, n))
        await conn.commit()
    return tid


async def upsert_offer(title_id: int, o: Offer, seen_at: float) -> None:
    await db.execute(
        """INSERT INTO availability(title_id, source, provider, provider_name, kind, monetization, quality,
               video, audio, audio_langs, subtitle_langs, url, extra, expires_on, seen_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(title_id, source, provider, monetization) DO UPDATE SET
               provider_name=excluded.provider_name, kind=excluded.kind, quality=excluded.quality,
               video=excluded.video, audio=excluded.audio, audio_langs=excluded.audio_langs,
               subtitle_langs=excluded.subtitle_langs, url=excluded.url, extra=excluded.extra,
               expires_on=excluded.expires_on, seen_at=excluded.seen_at""",
        (
            title_id, o.source, o.provider, o.provider_name, o.kind, o.monetization, o.quality,
            json.dumps(o.video), json.dumps(o.audio), json.dumps(o.audio_langs), json.dumps(o.subtitle_langs),
            o.url, json.dumps(o.extra), o.expires_on, seen_at,
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
