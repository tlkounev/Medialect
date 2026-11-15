"""Runs source synchronisations, records their status, schedules periodic runs."""

from __future__ import annotations

import asyncio
import logging
import time
import traceback

from . import ratings, settings as settings_mod
from .db import db
from .sources import justwatch, streaming_availability
from .sources.base import SourceError, SyncContext
from .sources.emby import EmbyLike
from .sources.plex import Plex

log = logging.getLogger("medialect")


def server_client(server: dict):
    return Plex(server) if server["type"] == "plex" else EmbyLike(server)


class SyncManager:
    def __init__(self):
        self.running: set[str] = set()
        self._task: asyncio.Task | None = None
        self._full_lock = asyncio.Lock()

    async def jobs(self) -> list[tuple[str, str, object]]:
        """[(job_id, label, coroutine_factory)] for everything that is enabled."""
        s = await settings_mod.load()
        out = []
        for srv in s["servers"]:
            if srv.get("enabled", True) and srv.get("url"):
                out.append((f"server:{srv['id']}", srv.get("name") or srv["type"], server_client(srv).sync))
        if s["justwatch"].get("enabled") and s["justwatch"].get("providers"):
            out.append(("justwatch", "JustWatch", justwatch.sync))
        sa = s["streaming_availability"]
        if sa.get("enabled") and sa.get("api_key") and sa.get("catalogs"):
            out.append(("sa", "Streaming Availability", streaming_availability.sync))
        out.append(("ratings", "Hodnocení", ratings.sync))
        return out

    async def run_job(self, job_id: str, fn) -> None:
        if job_id in self.running:
            return
        self.running.add(job_id)
        s = await settings_mod.load()
        ctx = SyncContext(source=job_id, settings=s)
        run_id = await db.execute("INSERT INTO sync_runs(source, started_at, status) VALUES(?,?,?)",
                                  (job_id, ctx.started, "running"))
        status, message = "ok", None
        try:
            await fn(ctx)
            status = "partial" if ctx.partial else "ok"
            message = "\n".join(ctx.notes[-20:]) or None
        except SourceError as e:
            status, message = "error", str(e)
        except Exception as e:  # noqa: BLE001
            log.error("sync %s failed: %s", job_id, traceback.format_exc())
            status, message = "error", f"{type(e).__name__}: {e}"
        finally:
            self.running.discard(job_id)
            await db.execute("UPDATE sync_runs SET finished_at=?, status=?, message=?, items=? WHERE id=?",
                             (time.time(), status, message, ctx.items, run_id))
            log.info("sync %s: %s (%s items)", job_id, status, ctx.items)

    async def run(self, only: str | None = None) -> None:
        async with self._full_lock:
            for job_id, _label, fn in await self.jobs():
                if only and job_id != only:
                    continue
                await self.run_job(job_id, fn)
            if not only:
                await db.kv_set("sync.last_full", time.time())

    def trigger(self, only: str | None = None) -> None:
        asyncio.create_task(self.run(only))

    async def status(self) -> list[dict]:
        out = []
        for job_id, label, _ in await self.jobs():
            row = await db.fetchone(
                "SELECT * FROM sync_runs WHERE source=? ORDER BY started_at DESC LIMIT 1", (job_id,))
            out.append({
                "id": job_id, "label": label, "running": job_id in self.running,
                "last": dict(row) if row else None,
            })
        return out

    async def _loop(self) -> None:
        await asyncio.sleep(10)
        while True:
            try:
                s = await settings_mod.load()
                interval = max(1.0, float(s.get("sync_interval_hours", 24))) * 3600
                last = await db.kv_get("sync.last_full", 0)
                if time.time() - last >= interval and not self._full_lock.locked():
                    await self.run()
            except Exception:  # noqa: BLE001
                log.error("scheduler: %s", traceback.format_exc())
            await asyncio.sleep(60)

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()


manager = SyncManager()
