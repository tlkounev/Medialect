"""Compares the running version with the newest v1.0.x tag on GitHub."""

from __future__ import annotations

import os
import re
import time

from .sources.base import http_client

REPO = os.environ.get("MEDIALECT_REPO", "tlkounev/medialect")
CHECK_EVERY_S = 15 * 60   # GitHub allows 60 unauthenticated requests per hour and IP
RETRY_AFTER_ERROR_S = 15 * 60
_VERSION = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")

_cache: dict = {"at": 0.0, "latest": None, "error": None}


def parse(v: str | None) -> tuple[int, int, int] | None:
    m = _VERSION.match((v or "").strip())
    return tuple(int(x) for x in m.groups()) if m else None


async def _latest_tag() -> str | None:
    async with http_client(timeout=10, headers={"Accept": "application/vnd.github+json"}) as c:
        r = await c.get(f"https://api.github.com/repos/{REPO}/tags", params={"per_page": 100})
        r.raise_for_status()
        versions = [parse(t.get("name")) for t in r.json()]
        versions = [v for v in versions if v]
        return ".".join(map(str, max(versions))) if versions else None


async def status(current: str) -> dict:
    """{current, latest, state}: state = current | update | unknown."""
    now = time.time()
    age = now - _cache["at"]
    if age > (RETRY_AFTER_ERROR_S if _cache["error"] else CHECK_EVERY_S):
        try:
            _cache.update(latest=await _latest_tag(), error=None)
        except Exception as e:  # noqa: BLE001 – offline, rate limit, GitHub down
            _cache.update(error=f"{type(e).__name__}: {e}")
        _cache["at"] = now
    cur, latest = parse(current), parse(_cache["latest"])
    if not cur or not latest or _cache["error"]:
        state = "unknown"
    elif latest > cur:
        state = "update"
    else:
        state = "current"
    return {"current": current, "latest": _cache["latest"], "state": state,
            "checked_at": _cache["at"], "error": _cache["error"],
            "url": f"https://github.com/{REPO}/tags"}
