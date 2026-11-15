"""Password login (set in the web UI on first run) + API token for other apps."""

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


async def _signer() -> TimestampSigner:
    key = await db.kv_get("auth.secret")
    if not key:
        key = secrets.token_hex(32)
        await db.kv_set("auth.secret", key)
    return TimestampSigner(key)


async def make_session() -> str:
    return (await _signer()).sign("admin").decode()


async def api_token(regenerate: bool = False) -> str:
    token = await db.kv_get("auth.api_token")
    if not token or regenerate:
        token = secrets.token_urlsafe(32)
        await db.kv_set("auth.api_token", token)
    return token


async def require_auth(request: Request) -> None:
    """FastAPI dependency: session cookie, or X-Api-Key header / api_key query."""
    supplied = request.headers.get("x-api-key") or request.query_params.get("api_key")
    if supplied:
        if hmac.compare_digest(supplied, await api_token()):
            return
        raise HTTPException(401, "Neplatný API klíč.")
    cookie = request.cookies.get(COOKIE)
    if cookie:
        try:
            (await _signer()).unsign(cookie, max_age=SESSION_DAYS * 86400)
            return
        except (BadSignature, SignatureExpired):
            pass
    raise HTTPException(401, "Nepřihlášen.")
