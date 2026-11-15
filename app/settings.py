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
        "csfd_daily_budget": 0,          # 0 = no daily limit
        "mdblist_api_key": "",
        "mdblist_daily_budget": 900,
        "tmdb_api_key": "",             # v3 API key or v4 read access token
        "tvmaze": True,                 # free, no key; series only
        "omdb_api_key": "",
        "omdb_daily_budget": 950,       # free key: 1000 requests/day
        "refresh_days": 14,
    },
}

SECRET_PATHS = [
    ("streaming_availability", "api_key"),
    ("ratings", "mdblist_api_key"),
    ("ratings", "tmdb_api_key"),
    ("ratings", "omdb_api_key"),
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
    if stored.get("ratings", {}).get("csfd_daily_budget") == 400 and not await db.kv_get("migrate.csfd_budget_v2"):
        stored["ratings"]["csfd_daily_budget"] = 0   # the old default was an arbitrary cap, not ČSFD's limit
        await db.kv_set("settings", stored)
        await db.kv_set("migrate.csfd_budget_v2", True)
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


LINK_MODES = ("auto", "public", "internal")
_CONNECTION_KEYS = ("type", "url", "token", "enabled")


def _clean_server(srv: dict, old: dict | None = None) -> dict:
    srv = dict(srv)
    if not srv.get("id"):
        srv["id"] = uuid.uuid4().hex[:8]
    if srv.get("token") == MASK:
        srv["token"] = (old or {}).get("token", "")
    srv["url"] = (srv.get("url") or "").strip().rstrip("/")
    srv["public_url"] = (srv.get("public_url") or "").strip().rstrip("/")
    srv["name"] = (srv.get("name") or "").strip()
    srv.setdefault("enabled", True)
    if srv.get("link_mode") not in LINK_MODES:
        srv["link_mode"] = "auto"
    return srv


async def save_server(server: dict) -> tuple[dict, bool]:
    """Add or update one server. Returns (server, connection_changed)."""
    current = await load()
    servers = list(current.get("servers", []))
    idx = next((i for i, s in enumerate(servers) if server.get("id") and s["id"] == server["id"]), None)
    old = servers[idx] if idx is not None else None
    srv = _clean_server(server, old)
    if not srv["url"]:
        raise ValueError("Chybí interní URL serveru.")
    if srv["type"] not in ("emby", "jellyfin", "plex"):
        raise ValueError("Neznámý typ serveru.")
    if idx is None:
        servers.append(srv)
    else:
        servers[idx] = srv
    current["servers"] = servers
    await db.kv_set("settings", current)
    changed = old is None or any(old.get(k) != srv.get(k) for k in _CONNECTION_KEYS)
    return srv, changed


async def delete_server(server_id: str) -> dict | None:
    current = await load()
    removed = next((s for s in current.get("servers", []) if s["id"] == server_id), None)
    current["servers"] = [s for s in current.get("servers", []) if s["id"] != server_id]
    await db.kv_set("settings", current)
    return removed


async def save(new: dict[str, Any]) -> dict[str, Any]:
    """Save settings from the UI. Masked secrets keep their stored value."""
    current = await load()
    merged = _merge(current, new)
    for section, key in SECRET_PATHS:
        if merged.get(section, {}).get(key) == MASK:
            merged[section][key] = current[section][key]
    old_servers = {s["id"]: s for s in current.get("servers", []) if s.get("id")}
    merged["servers"] = [_clean_server(s, old_servers.get(s.get("id")))
                         for s in new.get("servers", current.get("servers", []))]
    merged["country"] = (merged.get("country") or "CZ").upper()
    await db.kv_set("settings", merged)
    return merged
