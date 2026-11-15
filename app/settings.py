"""Application settings, stored in the DB and edited from the web UI."""

from __future__ import annotations

import copy
import uuid
from typing import Any

from .db import db

MASK = "••••••••"

DEFAULTS: dict[str, Any] = {
    "country": "CZ",
    "language": "cs",
    "sync_interval_hours": 24,
    "public_url": "",
    "justwatch": {
        "enabled": True,
        # JustWatch 3-letter provider short names (e.g. "nfx" = Netflix).
        "providers": [],
        "request_delay_s": 1.0,
    },
    "streaming_availability": {
        "enabled": False,
        "mode": "direct",  # direct | rapidapi
        "api_key": "",
        # Service ids from docs.movieofthenight.com (cz: netflix, prime, disney, hbo, apple, skyshowtime, ...)
        "catalogs": [],
        "daily_budget": 90,
    },
    # [{"id", "type": emby|jellyfin|plex, "name", "url", "public_url", "token", "enabled"}]
    "servers": [],
    "ratings": {
        "imdb_dataset": True,
        "justwatch_scores": True,
        "csfd": True,
        "csfd_daily_budget": 400,
        "mdblist_api_key": "",
        "mdblist_daily_budget": 900,
        "refresh_days": 14,
    },
}

SECRET_PATHS = [
    ("streaming_availability", "api_key"),
    ("ratings", "mdblist_api_key"),
]


def _merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


async def load() -> dict[str, Any]:
    stored = await db.kv_get("settings", {})
    return _merge(DEFAULTS, stored)


def masked(settings: dict[str, Any]) -> dict[str, Any]:
    """Copy of settings with secrets hidden (for the UI)."""
    s = copy.deepcopy(settings)
    for section, key in SECRET_PATHS:
        if s.get(section, {}).get(key):
            s[section][key] = MASK
    for srv in s.get("servers", []):
        if srv.get("token"):
            srv["token"] = MASK
    return s


async def save(new: dict[str, Any]) -> dict[str, Any]:
    """Save settings from the UI. Masked secrets keep their stored value."""
    current = await load()
    merged = _merge(current, new)
    for section, key in SECRET_PATHS:
        if merged.get(section, {}).get(key) == MASK:
            merged[section][key] = current[section][key]
    old_servers = {s["id"]: s for s in current.get("servers", []) if s.get("id")}
    servers = []
    for srv in new.get("servers", current.get("servers", [])):
        srv = dict(srv)
        srv.setdefault("id", uuid.uuid4().hex[:8])
        if not srv.get("id"):
            srv["id"] = uuid.uuid4().hex[:8]
        if srv.get("token") == MASK:
            srv["token"] = old_servers.get(srv["id"], {}).get("token", "")
        srv["url"] = (srv.get("url") or "").rstrip("/")
        srv["public_url"] = (srv.get("public_url") or "").rstrip("/")
        srv.setdefault("enabled", True)
        servers.append(srv)
    merged["servers"] = servers
    merged["country"] = (merged.get("country") or "CZ").upper()
    await db.kv_set("settings", merged)
    return merged
