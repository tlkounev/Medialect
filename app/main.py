from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import Body, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import auth, queries, settings as settings_mod
from .db import db
from .sources import justwatch
from .sources.base import SourceError, http_client
from .sync import manager, server_client

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
STATIC = os.path.join(os.path.dirname(__file__), "static")
VERSION = "0.1.0"


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.open()
    await db.execute("UPDATE sync_runs SET status='error', message='Přerušeno restartem', finished_at=? "
                     "WHERE status='running'", (time.time(),))
    if os.environ.get("DISABLE_SCHEDULER") != "1":
        manager.start()
    yield
    await manager.stop()
    await db.close()


app = FastAPI(title="Medialect", version=VERSION, lifespan=lifespan)
authed = [Depends(auth.require_auth)]


# --- auth -----------------------------------------------------------------
def _set_cookie(resp: Response, value: str) -> None:
    resp.set_cookie(auth.COOKIE, value, max_age=auth.SESSION_DAYS * 86400, httponly=True, samesite="lax")


@app.get("/api/auth/state")
async def auth_state(request: Request):
    logged = True
    try:
        await auth.require_auth(request)
    except HTTPException:
        logged = False
    return {"configured": await auth.is_configured(), "logged_in": logged, "version": VERSION}


@app.post("/api/auth/setup")
async def auth_setup(response: Response, password: str = Body(..., embed=True)):
    if await auth.is_configured():
        raise HTTPException(409, "Heslo už je nastavené.")
    await auth.set_password(password)
    _set_cookie(response, await auth.make_session())
    return {"ok": True}


@app.post("/api/auth/login")
async def auth_login(response: Response, password: str = Body(..., embed=True)):
    if not await auth.check_password(password):
        raise HTTPException(401, "Špatné heslo.")
    _set_cookie(response, await auth.make_session())
    return {"ok": True}


@app.post("/api/auth/logout")
async def auth_logout(response: Response):
    response.delete_cookie(auth.COOKIE)
    return {"ok": True}


@app.post("/api/auth/password", dependencies=authed)
async def auth_password(old: str = Body(...), new: str = Body(...)):
    if not await auth.check_password(old):
        raise HTTPException(401, "Původní heslo nesouhlasí.")
    await auth.set_password(new)
    return {"ok": True}


@app.get("/api/auth/token", dependencies=authed)
async def get_token():
    return {"token": await auth.api_token()}


@app.post("/api/auth/token/regenerate", dependencies=authed)
async def regen_token():
    return {"token": await auth.api_token(regenerate=True)}


# --- public catalogue (no login) ----------------------------------------------
@app.get("/api/search")
async def api_search(q: str, type: str | None = Query(None, pattern="^(movie|show)$"),
                     provider: str | None = None, limit: int = Query(30, ge=1, le=100)):
    provs = [p for p in (provider or "").split(",") if p] or None
    return {"items": await queries.search(q, type, provs, limit)}


@app.get("/api/catalog")
async def api_catalog(q: str | None = None, provider: str | None = None, type: str | None = Query(None, pattern="^(movie|show)$"),
                      min_quality: str | None = None, video: str | None = None, audio: str | None = None,
                      lang: str | None = None, sort: str = "imdb", order: str = "desc",
                      page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200)):
    return await queries.catalog(provider, type, min_quality, video, audio, lang, sort, order, page, page_size, q=q)


@app.get("/api/titles/{title_id}")
async def api_title(title_id: int):
    items = await queries.hydrate([title_id])
    if not items:
        raise HTTPException(404, "Titul nenalezen.")
    return items[0]


@app.get("/api/titles/by/{kind}/{value}")
async def api_title_by_id(kind: str, value: str):
    """Lookup by external id, e.g. /api/titles/by/imdb/tt0133093 or /by/tmdb_movie/603."""
    row = await db.fetchone("SELECT title_id FROM title_ids WHERE kind=? AND value=?", (kind, value))
    if not row:
        raise HTTPException(404, "Titul nenalezen.")
    return (await queries.hydrate([row["title_id"]]))[0]


@app.get("/api/providers")
async def api_providers():
    return {"items": await queries.providers()}


@app.get("/api/stats")
async def api_stats():
    return await queries.stats()


_POSTER_PREFIXES = ("/Items/", "/photo/:/transcode")


@app.get("/api/poster/{server_id}")
async def api_poster(server_id: str, path: str):
    if not path.startswith(_POSTER_PREFIXES) or ".." in path:
        raise HTTPException(400, "Nepovolená cesta.")
    s = await settings_mod.load()
    srv = next((x for x in s["servers"] if x["id"] == server_id), None)
    if not srv:
        raise HTTPException(404, "Server nenalezen.")
    headers = ({"X-Plex-Token": srv.get("token", "")} if srv["type"] == "plex"
               else {"X-Emby-Token": srv.get("token", "")} if srv["type"] == "emby"
               else {"Authorization": f'MediaBrowser Token="{srv.get("token", "")}"'})
    async with http_client(headers=headers, timeout=20) as c:
        r = await c.get(srv["url"].rstrip("/") + path)
    if r.status_code != 200:
        raise HTTPException(r.status_code, "Obrázek nedostupný.")
    return Response(r.content, media_type=r.headers.get("content-type", "image/jpeg"),
                    headers={"Cache-Control": "private, max-age=604800"})


# --- administration (login required) -----------------------------------------
@app.get("/api/settings", dependencies=authed)
async def get_settings():
    return settings_mod.masked(await settings_mod.load())


@app.put("/api/settings", dependencies=authed)
async def put_settings(body: dict = Body(...)):
    before = await settings_mod.load()
    saved = await settings_mod.save(body)
    # start what the change made relevant, instead of waiting for the next scheduled run
    await manager.trigger_new_servers()
    if saved["justwatch"].get("enabled") and (
            sorted(saved["justwatch"].get("providers") or []) != sorted(before["justwatch"].get("providers") or [])
            or not before["justwatch"].get("enabled")):
        manager.trigger("justwatch")
    sa_keys = ("enabled", "api_key", "catalogs", "mode")
    if saved["streaming_availability"].get("enabled") and any(
            saved["streaming_availability"].get(k) != before["streaming_availability"].get(k) for k in sa_keys):
        manager.trigger("sa")
    return settings_mod.masked(saved)


@app.post("/api/servers/test", dependencies=authed)
async def test_server(server: dict = Body(...)):
    if server.get("token") == settings_mod.MASK:
        stored = next((x for x in (await settings_mod.load())["servers"] if x["id"] == server.get("id")), {})
        server["token"] = stored.get("token", "")
    server.setdefault("id", "test")
    try:
        return {"ok": True, "info": await server_client(server).test()}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": f"{type(e).__name__}: {e}"}, status_code=200)


@app.get("/api/justwatch/providers", dependencies=authed)
async def jw_providers(country: str | None = None):
    s = await settings_mod.load()
    try:
        return {"items": await justwatch.list_providers((country or s["country"]).upper())}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"JustWatch nedostupný: {e}")


@app.get("/api/sync/status", dependencies=authed)
async def sync_status():
    return {"jobs": await manager.status(), "last_full": await db.kv_get("sync.last_full", 0),
            "running": bool(manager.running),
            "budgets": {n: await db.budget_used(n) for n in ("sa", "csfd", "mdblist")}}


@app.post("/api/sync", dependencies=authed)
async def sync_now(job: str | None = None):
    manager.trigger(job)
    return {"ok": True}


@app.get("/api/health")
async def health():
    return {"ok": True}


# --- web UI -----------------------------------------------------------------
@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC, "index.html"))


app.mount("/static", StaticFiles(directory=STATIC), name="static")
