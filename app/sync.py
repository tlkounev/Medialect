"""Runs source synchronisations, records their status, schedules periodic runs."""

from __future__ import annotations

import asyncio
import logging
import time
import traceback

from . import ratings, settings as settings_mod, store
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
        self.running: dict[str, SyncContext] = {}
        self.queued: set[str] = set()
        self._ratings_again = False
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
        s = await settings_mod.load()
        ctx = SyncContext(source=job_id, settings=s)
        self.running[job_id] = ctx
        self.queued.discard(job_id)
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
            self.running.pop(job_id, None)
            await db.execute("UPDATE sync_runs SET finished_at=?, status=?, message=?, items=? WHERE id=?",
                             (time.time(), status, message, ctx.items, run_id))
            log.info("sync %s: %s (%s items)", job_id, status, ctx.items)
        # new titles need ratings: run (or re-run) the ratings job after every source sync
        if job_id == "ratings":
            if self._ratings_again:
                self._ratings_again = False
                self.trigger("ratings")
        elif status != "error" and not self._full_lock.locked():
            if "ratings" in self.running:
                self._ratings_again = True
            else:
                self.trigger("ratings")

    async def run(self, only: str | None = None) -> None:
        if only:
            # a single job runs right away, independently of a full run in progress
            for job_id, _label, fn in await self.jobs():
                if job_id == only:
                    await self.run_job(job_id, fn)
            return
        async with self._full_lock:
            if n := await store.repair_mixed_titles():
                log.info("repair: %d titles mixing two works dropped, the full sync recreates them", n)
            jobs = await self.jobs()
            self.queued.update(j for j, _, _ in jobs if j not in self.running)
            try:
                for job_id, _label, fn in jobs:
                    if job_id in self.running:
                        continue  # already started on its own
                    await self.run_job(job_id, fn)
            finally:
                self.queued.clear()
            # a run with no source configured yet (fresh install) does not count as a full sync
            if any(j != "ratings" for j, _, _ in jobs):
                await db.kv_set("sync.last_full", time.time())

    def trigger(self, only: str | None = None) -> None:
        asyncio.create_task(self.run(only))

    async def trigger_new_servers(self) -> None:
        """Start servers that have never been synchronised (e.g. just added in the settings)."""
        for job_id, _label, _fn in await self.jobs():
            if job_id.startswith("server:") and job_id not in self.running:
                row = await db.fetchone("SELECT 1 FROM sync_runs WHERE source=? LIMIT 1", (job_id,))
                if not row:
                    self.trigger(job_id)

    async def status(self) -> list[dict]:
        out = []
        for job_id, label, _ in await self.jobs():
            row = await db.fetchone(
                "SELECT * FROM sync_runs WHERE source=? ORDER BY started_at DESC LIMIT 1", (job_id,))
            ctx = self.running.get(job_id)
            out.append({
                "id": job_id, "label": label,
                "running": ctx is not None,
                "queued": job_id in self.queued,
                "progress": {"phase": ctx.phase, "items": ctx.items, "started_at": ctx.started,
                             "percent": ctx.percent} if ctx else None,
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
                elif await self._jw_unfinished(s):
                    self.trigger("justwatch")
            except Exception:  # noqa: BLE001
                log.error("scheduler: %s", traceback.format_exc())
            await asyncio.sleep(60)

    RESUME_AFTER_S = 10 * 60

    async def _jw_unfinished(self, s: dict) -> bool:
        """An interrupted JustWatch run is continued on its own 10 minutes after it stopped."""
        if self._full_lock.locked() or "justwatch" in self.running or not s["justwatch"].get("enabled") \
                or not s["justwatch"].get("providers") or not await justwatch.resume_pending():
            return False
        row = await db.fetchone(
            "SELECT finished_at FROM sync_runs WHERE source='justwatch' ORDER BY started_at DESC LIMIT 1")
        return bool(row and row["finished_at"] and time.time() - row["finished_at"] >= self.RESUME_AFTER_S)

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()


manager = SyncManager()
