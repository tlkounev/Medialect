"""Builds media-server links for the catalogue from the server settings and the viewer's network."""

from __future__ import annotations

import ipaddress
from urllib.parse import quote

PLEX_APP = "https://app.plex.tv/desktop"


def is_lan(client_ip: str | None) -> bool:
    try:
        ip = ipaddress.ip_address((client_ip or "").split("%")[0])
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local


def _path(server_type: str, extra: dict) -> str | None:
    if server_type == "emby" and extra.get("item_id"):
        return f"/web/index.html#!/item?id={extra['item_id']}&serverId={extra.get('server_id', '')}"
    if server_type == "jellyfin" and extra.get("item_id"):
        return f"/web/#/details?id={extra['item_id']}&serverId={extra.get('server_id', '')}"
    if server_type == "plex" and extra.get("rating_key"):
        key = quote(f"/library/metadata/{extra['rating_key']}", safe="")
        return f"#!/server/{extra.get('machine_id', '')}/details?key={key}"
    return None


def server_link(server: dict, extra: dict, lan: bool) -> str | None:
    """Link to one library item, following the server's link_mode (auto | public | internal)."""
    path = _path(server.get("type", ""), extra)
    if not path:
        return None
    internal, public = server.get("url") or "", server.get("public_url") or ""
    mode = server.get("link_mode") or "auto"
    use_internal = mode == "internal" or (mode == "auto" and lan)
    if server.get("type") == "plex":
        if use_internal and internal:
            return f"{internal}/web/index.html{path}"
        if public:
            return f"{public}/web/index.html{path}"
        return f"{PLEX_APP}/{path}"          # app.plex.tv works from anywhere when signed in
    base = internal if use_internal else (public or internal)
    return f"{base}{path}" if base else None
