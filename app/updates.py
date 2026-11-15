"""Compares the running version with the newest v1.0.x tag on GitHub."""

from __future__ import annotations

import os
import re
import time

from .sources.base import http_client

REPO = os.environ.get("MEDIALECT_REPO", "tlkounev/medialect")
CHECK_EVERY_S = 5 * 60      # background interval
FORCE_MIN_S = 60            # opening/focusing the page checks at most once a minute
RETRY_AFTER_ERROR_S = 5 * 60
# Conditional requests (ETag -> 304 Not Modified) do not count against GitHub's
# limit of 60 unauthenticated requests per hour, so frequent checks stay cheap.
_VERSION = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")

_cache: dict = {"at": 0.0, "latest": None, "error": None, "etag": None}


def parse(v: str | None) -> tuple[int, int, int] | None:
    m = _VERSION.match((v or "").strip())
    return tuple(int(x) for x in m.groups()) if m else None


async def _latest_tag() -> str | None:
    headers = {"Accept": "application/vnd.github+json"}
    if _cache.get("etag") and _cache.get("latest"):
        headers["If-None-Match"] = _cache["etag"]
    async with http_client(timeout=10, headers=headers) as c:
        r = await c.get(f"https://api.github.com/repos/{REPO}/tags", params={"per_page": 100})
        if r.status_code == 304:
            return _cache["latest"]
        r.raise_for_status()
        _cache["etag"] = r.headers.get("etag")
        versions = [parse(t.get("name")) for t in r.json()]
        versions = [v for v in versions if v]
        return ".".join(map(str, max(versions))) if versions else None


async def status(current: str, force: bool = False) -> dict:
    """{current, latest, state}: state = current | update | unknown."""
    now = time.time()
    age = now - _cache["at"]
    due = RETRY_AFTER_ERROR_S if _cache["error"] else CHECK_EVERY_S
    if age > due or (force and age > FORCE_MIN_S):
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
