"""The refresh button on a title: that one title again from every source, then its ratings."""

from __future__ import annotations

import asyncio
import json
import logging

from . import ratings, settings as settings_mod
from .db import db
from .queries import jw_providers
from .sources import ivysilani, justwatch, streaming_availability
from .sources.base import SourceError, SyncContext

log = logging.getLogger("medialect")


async def _title(title_id: int) -> dict | None:
    row = await db.fetchone("SELECT id, type, title, original_title, year FROM titles WHERE id=?", (title_id,))
    if not row:
        return None
    ids = {r["kind"]: r["value"] for r in await db.fetchall(
        "SELECT kind, value FROM title_ids WHERE title_id=?", (title_id,))}
    offers = []
    for r in await db.fetchall("SELECT source, url, extra FROM availability WHERE title_id=?", (title_id,)):
        try:
            extra = json.loads(r["extra"] or "{}") or {}
        except ValueError:
            extra = {}
        offers.append({"source": r["source"], "url": r["url"], "extra": extra})
    return {**dict(row), "ids": ids, "offers": offers}


async def refresh_title(title_id: int) -> list[str]:
    """Own servers, JustWatch, iVysílání and Streaming Availability for this title at the same time, then
    every rating source. Returns what could not be refreshed (empty = all done)."""
    from .sync import server_client
    s = await settings_mod.load()
    title = await _title(title_id)
    if not title:
        return []
    ctx = SyncContext(source="refresh", settings=s)
    jobs: list[tuple[str, object]] = []
    for srv in s["servers"]:
        if srv.get("enabled", True) and srv.get("url"):
            jobs.append((srv.get("name") or srv["type"], server_client(srv).refresh_title))
    if s["justwatch"].get("enabled") and jw_providers(s["justwatch"].get("providers")):
        jobs.append(("JustWatch", justwatch.refresh_title))
    if ivysilani.selected(s):
        jobs.append(("iVysílání", ivysilani.refresh_title))
    sa = s["streaming_availability"]
    if sa.get("enabled") and sa.get("api_key") and sa.get("catalogs"):
        jobs.append(("Streaming Availability", streaming_availability.refresh_title))

    async def run(label: str, fn) -> str | None:
        try:
            await fn(title, ctx)
        except SourceError as e:
            return str(e) if label in str(e) else f"{label}: {e}"
        except Exception as e:  # noqa: BLE001 - one unreachable source must not stop the others
            log.warning("refresh %s %s: %s", title_id, label, e)
            return f"{label}: {type(e).__name__}"
        return None

    notes = [n for n in await asyncio.gather(*(run(label, fn) for label, fn in jobs)) if n]
    return notes + await ratings.refresh_title(title_id, s)
