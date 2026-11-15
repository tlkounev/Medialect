"""SQLite storage. One shared aiosqlite connection; writes are serialised by a lock."""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any, Iterable

import aiosqlite

DATA_DIR = os.environ.get("DATA_DIR", "/data")
DB_PATH = os.path.join(DATA_DIR, "medialect.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS titles (
    id             INTEGER PRIMARY KEY,
    type           TEXT NOT NULL,          -- movie | show
    title          TEXT NOT NULL,
    original_title TEXT,
    year           INTEGER,
    poster         TEXT,
    created_at     REAL,
    updated_at     REAL
);

-- External identifiers: imdb, tmdb_movie, tmdb_tv, tvdb, csfd, jw, sa
CREATE TABLE IF NOT EXISTS title_ids (
    kind     TEXT NOT NULL,
    value    TEXT NOT NULL,
    title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
    PRIMARY KEY (kind, value)
);
CREATE INDEX IF NOT EXISTS ix_title_ids_tid ON title_ids(title_id);

-- Normalised names (all languages) used for search and fallback matching
CREATE TABLE IF NOT EXISTS title_names (
    title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
    norm     TEXT NOT NULL,
    PRIMARY KEY (title_id, norm)
);
CREATE INDEX IF NOT EXISTS ix_title_names_norm ON title_names(norm);

CREATE TABLE IF NOT EXISTS availability (
    id             INTEGER PRIMARY KEY,
    title_id       INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
    source         TEXT NOT NULL,   -- justwatch | sa | emby:<id> | jellyfin:<id> | plex:<id>
    provider       TEXT NOT NULL,   -- canonical provider key (netflix, oneplay, emby-<id>, ...)
    provider_name  TEXT,
    kind           TEXT NOT NULL,   -- stream | library
    monetization   TEXT NOT NULL,   -- flatrate | free | ads | addon | library
    quality        TEXT,            -- SD | HD | FHD | QHD | UHD
    video          TEXT,            -- JSON list, e.g. ["DV","HDR10","HEVC"]
    audio          TEXT,            -- JSON list, e.g. ["Atmos","TrueHD","7.1"]
    audio_langs    TEXT,            -- JSON list of ISO 639-1 codes
    subtitle_langs TEXT,            -- JSON list of ISO 639-1 codes
    url            TEXT,            -- deep link / web link
    extra          TEXT,            -- JSON object
    expires_on     TEXT,
    seen_at        REAL NOT NULL,
    UNIQUE (title_id, source, provider, monetization)
);
CREATE INDEX IF NOT EXISTS ix_av_provider ON availability(provider);
CREATE INDEX IF NOT EXISTS ix_av_source ON availability(source, seen_at);

CREATE TABLE IF NOT EXISTS ratings (
    title_id   INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
    source     TEXT NOT NULL,       -- imdb | csfd | tmdb | rottentomatoes | metacritic | letterboxd | trakt | mdblist ...
    value      REAL,                -- normalised 0..100, NULL = not found
    display    TEXT,                -- as shown by the source ("7.8", "83 %")
    votes      INTEGER,
    url        TEXT,
    updated_at REAL NOT NULL,
    PRIMARY KEY (title_id, source)
);

CREATE TABLE IF NOT EXISTS sync_runs (
    id          INTEGER PRIMARY KEY,
    source      TEXT NOT NULL,
    started_at  REAL NOT NULL,
    finished_at REAL,
    status      TEXT NOT NULL,      -- running | ok | partial | error
    message     TEXT,
    items       INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_sync_runs_source ON sync_runs(source, started_at);
"""


class Database:
    def __init__(self, path: str = DB_PATH):
        self.path = path
        self.conn: aiosqlite.Connection | None = None
        self.lock = asyncio.Lock()

    async def open(self) -> None:
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.conn = await aiosqlite.connect(self.path)
        self.conn.row_factory = aiosqlite.Row
        await self.conn.execute("PRAGMA journal_mode=WAL")
        await self.conn.execute("PRAGMA foreign_keys=ON")
        await self.conn.execute("PRAGMA synchronous=NORMAL")
        await self.conn.executescript(SCHEMA)
        await self.conn.commit()

    async def close(self) -> None:
        if self.conn:
            await self.conn.close()

    # --- generic helpers -------------------------------------------------
    async def fetchone(self, sql: str, params: Iterable[Any] = ()) -> aiosqlite.Row | None:
        async with self.conn.execute(sql, tuple(params)) as cur:
            return await cur.fetchone()

    async def fetchall(self, sql: str, params: Iterable[Any] = ()) -> list[aiosqlite.Row]:
        async with self.conn.execute(sql, tuple(params)) as cur:
            return list(await cur.fetchall())

    async def execute(self, sql: str, params: Iterable[Any] = ()) -> int:
        """Execute + commit under the write lock. Returns lastrowid."""
        async with self.lock:
            cur = await self.conn.execute(sql, tuple(params))
            await self.conn.commit()
            return cur.lastrowid

    # --- key/value -------------------------------------------------------
    async def kv_get(self, key: str, default: Any = None) -> Any:
        row = await self.fetchone("SELECT value FROM kv WHERE key=?", (key,))
        return json.loads(row["value"]) if row else default

    async def kv_set(self, key: str, value: Any) -> None:
        await self.execute(
            "INSERT INTO kv(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)),
        )

    async def kv_delete_prefix(self, prefix: str) -> None:
        await self.execute("DELETE FROM kv WHERE key LIKE ?", (prefix + "%",))

    # --- daily request budgets ------------------------------------------
    async def budget_take(self, name: str, limit: int) -> bool:
        """Consume one request from a per-day budget. False when exhausted."""
        if limit <= 0:
            return True  # unlimited
        key = f"budget:{name}:{time.strftime('%Y-%m-%d')}"
        used = await self.kv_get(key, 0)
        if used >= limit:
            return False
        await self.kv_set(key, used + 1)
        return True

    async def budget_used(self, name: str) -> int:
        return await self.kv_get(f"budget:{name}:{time.strftime('%Y-%m-%d')}", 0)


db = Database()
