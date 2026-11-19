"""Password login (set in the web UI on first run).

Two roles: the admin password opens everything; an optional connection password opens only the
catalogue (for the apps and people who only watch). The admin password works for connecting too.
A session is sent as the cookie (web), as "Authorization: Bearer <session>" (the app connected to this
server) or as ?s=<session> (images, which cannot carry a header)."""

from __future__ import annotations

import hashlib
import hmac
import secrets

from fastapi import HTTPException, Request
from itsdangerous import BadSignature, SignatureExpired, TimestampSigner

from .db import db

COOKIE = "ml_session"
SESSION_DAYS = 30
_ITER = 240_000


def _hash(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), _ITER).hex()


async def is_configured() -> bool:
    return bool(await db.kv_get("auth.password"))


async def set_password(password: str) -> None:
    if len(password) < 8:
        raise HTTPException(400, "Heslo musí mít aspoň 8 znaků.")
    salt = secrets.token_hex(16)
    await db.kv_set("auth.password", {"salt": salt, "hash": _hash(password, salt)})


async def check_password(password: str) -> bool:
    stored = await db.kv_get("auth.password")
    if not stored:
        return False
    return hmac.compare_digest(stored["hash"], _hash(password, stored["salt"]))


async def set_viewer_password(password: str | None) -> None:
    """The connection password (catalogue only); None removes it."""
    if not password:
        await db.kv_set("auth.viewer", None)
        return
    if len(password) < 8:
        raise HTTPException(400, "Heslo musí mít aspoň 8 znaků.")
    salt = secrets.token_hex(16)
    # a new password ends the sessions opened with the old one (gen is in each viewer session)
    await db.kv_set("auth.viewer", {"salt": salt, "hash": _hash(password, salt), "gen": secrets.token_hex(4)})


async def has_viewer_password() -> bool:
    return bool(await db.kv_get("auth.viewer"))


async def login_role(password: str) -> str | None:
    """"admin", "viewer" or None."""
    if await check_password(password):
        return "admin"
    stored = await db.kv_get("auth.viewer")
    if stored and hmac.compare_digest(stored["hash"], _hash(password, stored["salt"])):
        return "viewer"
    return None


async def _signer() -> TimestampSigner:
    key = await db.kv_get("auth.secret")
    if not key:
        key = secrets.token_hex(32)
        await db.kv_set("auth.secret", key)
    return TimestampSigner(key)


async def make_session(role: str = "admin") -> str:
    if role == "viewer":
        role = f"viewer:{((await db.kv_get('auth.viewer')) or {}).get('gen', '')}"
    return (await _signer()).sign(role).decode()


async def api_token(regenerate: bool = False) -> str:
    token = await db.kv_get("auth.api_token")
    if not token or regenerate:
        token = secrets.token_urlsafe(32)
        await db.kv_set("auth.api_token", token)
    return token


async def role_of(request: Request) -> str | None:
    """The role of the request's session (or API key), None when not logged in."""
    supplied = request.headers.get("x-api-key") or request.query_params.get("api_key")
    if supplied:
        return "admin" if hmac.compare_digest(supplied, await api_token()) else None
    bearer = request.headers.get("authorization", "")
    session = (bearer[7:] if bearer.lower().startswith("bearer ") else None) \
        or request.query_params.get("s") or request.cookies.get(COOKIE)
    if not session:
        return None
    try:
        role = (await _signer()).unsign(session, max_age=SESSION_DAYS * 86400).decode()
    except (BadSignature, SignatureExpired):
        return None
    if role.startswith("viewer:"):
        # the connection password was removed or changed: its sessions end
        stored = await db.kv_get("auth.viewer")
        return "viewer" if stored and role == f"viewer:{stored.get('gen', '')}" else None
    return "admin" if role == "admin" else None


async def require_auth(request: Request) -> None:
    """FastAPI dependency: the administration (admin password)."""
    role = await role_of(request)
    if role != "admin":
        raise HTTPException(403 if role else 401, "Jen pro správce." if role else "Nepřihlášen.")


async def require_view(request: Request) -> None:
    """FastAPI dependency: the catalogue (admin or connection password)."""
    if not await role_of(request):
        raise HTTPException(401, "Nepřihlášen.")
