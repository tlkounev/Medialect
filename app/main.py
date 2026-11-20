from __future__ import annotations

import logging
import os
from urllib.parse import urlsplit
import time
import httpx
from contextlib import asynccontextmanager

from fastapi import Body, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import auth, links, queries, settings as settings_mod, updates
from .db import db
from .sources import ivysilani, justwatch
from .sources.base import SourceError, http_client
from .sync import manager, server_client

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
STATIC = os.path.join(os.path.dirname(__file__), "static")
VERSION = os.environ.get("APP_VERSION", "dev")


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
viewers = [Depends(auth.require_view)]     # the catalogue: admin or connection password


# --- auth -----------------------------------------------------------------
def _set_cookie(resp: Response, value: str) -> None:
    resp.set_cookie(auth.COOKIE, value, max_age=auth.SESSION_DAYS * 86400, httponly=True, samesite="lax")


@app.get("/api/auth/state")
async def auth_state(request: Request):
    role = await auth.role_of(request)
    s = await settings_mod.load()
    return {"configured": await auth.is_configured(), "logged_in": role == "admin", "role": role,
            "version": VERSION, "public_url": s.get("public_url", "")}


@app.post("/api/auth/setup")
async def auth_setup(response: Response, password: str = Body(..., embed=True)):
    if await auth.is_configured():
        raise HTTPException(409, "Heslo už je nastavené.")
    await auth.set_password(password)
    await db.kv_set("onboarding.pending", True)   # first run: the admin gets the setup wizard
    await db.kv_set("migrate.csfd_optin_v3", True)   # fresh install: ČSFD stays opt-in
    _set_cookie(response, await auth.make_session())
    return {"ok": True}


@app.get("/api/onboarding", dependencies=authed)
async def onboarding_state():
    return {"pending": bool(await db.kv_get("onboarding.pending", False))}


@app.post("/api/onboarding/done", dependencies=authed)
async def onboarding_done():
    await db.kv_set("onboarding.pending", False)
    return {"ok": True}


@app.post("/api/auth/login")
async def auth_login(response: Response, password: str = Body(..., embed=True)):
    role = await auth.login_role(password)
    if not role:
        raise HTTPException(401, "Špatné heslo.")
    session = await auth.make_session(role)
    _set_cookie(response, session)
    # the app connected to this server keeps the session and sends it as a Bearer header
    return {"ok": True, "role": role, "session": session}


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


@app.get("/api/auth/viewer", dependencies=authed)
async def viewer_state():
    return {"set": await auth.has_viewer_password()}


@app.post("/api/auth/viewer", dependencies=authed)
async def viewer_set(password: str | None = Body(None, embed=True)):
    """The connection password (catalogue only); empty removes it."""
    await auth.set_viewer_password(password or None)
    return {"set": await auth.has_viewer_password()}


@app.get("/api/auth/token", dependencies=authed)
async def get_token():
    return {"token": await auth.api_token()}


@app.post("/api/auth/token/regenerate", dependencies=authed)
async def regen_token():
    return {"token": await auth.api_token(regenerate=True)}


# --- catalogue (admin or connection password) ------------------------------------
async def link_ctx(request: Request) -> dict:
    """Library links follow each server's link_mode; "auto" = internal URL for viewers on the LAN.
    A request that came in through the public address is from outside, whatever the proxy's address."""
    s = await settings_mod.load()
    public = urlsplit(s.get("public_url") or "").hostname
    host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(":")[0].lower()
    outside = bool(public) and host == public.lower()
    return {"servers": {srv["id"]: srv for srv in s["servers"]},
            "lan": not outside and links.is_lan(request.client.host if request.client else None)}


@app.get("/api/search", dependencies=viewers)
async def api_search(request: Request, q: str, type: str | None = Query(None, pattern="^(movie|show)$"),
                     provider: str | None = None, limit: int = Query(30, ge=1, le=100)):
    provs = [p for p in (provider or "").split(",") if p] or None
    return {"items": await queries.search(q, type, provs, limit, link_ctx=await link_ctx(request))}


@app.get("/api/catalog", dependencies=viewers)
async def api_catalog(request: Request, q: str | None = None, provider: str | None = None, type: str | None = Query(None, pattern="^(movie|show)(,(movie|show))?$"),
                      min_quality: str | None = None, video: str | None = None, audio: str | None = None,
                      lang: str | None = None, sub: str | None = None, quality: str | None = None,
                      sort: str = "added", order: str = "desc",
                      page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200)):
    return await queries.catalog(provider, type, min_quality, video, audio, lang, sub, quality, sort, order, page,
                                 page_size, q=q,
                                 link_ctx=await link_ctx(request))


@app.get("/api/titles/{title_id}", dependencies=viewers)
async def api_title(request: Request, title_id: int):
    items = await queries.hydrate([title_id], await link_ctx(request))
    if not items:
        raise HTTPException(404, "Titul nenalezen.")
    return items[0]


@app.post("/api/titles/{title_id}/refresh", dependencies=viewers)
async def api_title_refresh(request: Request, title_id: int):
    """The refresh button on a title: that title again from every source (own servers, JustWatch, iVysílání,
    Streaming Availability) and all its ratings, now."""
    from . import refresh as refresh_mod
    notes = await refresh_mod.refresh_title(title_id)
    items = await queries.hydrate([title_id], await link_ctx(request))
    if not items:
        raise HTTPException(404, "Titul nenalezen.")
    return {**items[0], "refresh_note": " · ".join(notes) or None}


@app.get("/api/titles/by/{kind}/{value}", dependencies=viewers)
async def api_title_by_id(request: Request, kind: str, value: str):
    """Lookup by external id, e.g. /api/titles/by/imdb/tt0133093 or /by/tmdb_movie/603."""
    row = await db.fetchone("SELECT title_id FROM title_ids WHERE kind=? AND value=?", (kind, value))
    if not row:
        raise HTTPException(404, "Titul nenalezen.")
    return (await queries.hydrate([row["title_id"]], await link_ctx(request)))[0]


@app.get("/api/facets", dependencies=viewers)
async def api_facets():
    return await queries.facets()


@app.get("/api/providers", dependencies=viewers)
async def api_providers():
    return {"items": await queries.providers()}


@app.get("/api/stats", dependencies=viewers)
async def api_stats():
    return await queries.stats()


_POSTER_PREFIXES = ("/Items/", "/photo/:/transcode")


# service logos for the web's logo evening-out (a canvas reads only same-origin pictures): only these hosts
_LOGO_HOSTS = ("images.justwatch.com", "icons.duckduckgo.com")
_logo_cache: dict[str, tuple[bytes, str]] = {}


@app.get("/api/logo", dependencies=viewers)
async def api_logo(url: str):
    host = urlsplit(url).hostname or ""
    if not url.startswith("https://") or host not in _LOGO_HOSTS:
        raise HTTPException(400, "Nepovolená adresa.")
    if url not in _logo_cache:
        try:
            async with http_client(timeout=20) as c:
                r = await c.get(url)
        except httpx.HTTPError:
            raise HTTPException(502, "Logo nedostupné.")
        if r.status_code != 200:
            raise HTTPException(r.status_code, "Logo nedostupné.")
        if len(_logo_cache) > 500:
            _logo_cache.clear()
        _logo_cache[url] = (r.content, r.headers.get("content-type", "image/png"))
    body, ctype = _logo_cache[url]
    return Response(body, media_type=ctype, headers={"Cache-Control": "private, max-age=604800"})


@app.get("/api/poster/{server_id}", dependencies=viewers)
async def api_poster(server_id: str, path: str):
    if not (path.startswith(_POSTER_PREFIXES) or path == "/web/favicon.ico") or ".." in path:
        raise HTTPException(400, "Nepovolená cesta.")
    s = await settings_mod.load()
    srv = next((x for x in s["servers"] if x["id"] == server_id), None)
    if not srv:
        raise HTTPException(404, "Server nenalezen.")
    headers = ({"X-Plex-Token": srv.get("token", "")} if srv["type"] == "plex"
               else {"X-Emby-Token": srv.get("token", "")} if srv["type"] == "emby"
               else {"Authorization": f'MediaBrowser Token="{srv.get("token", "")}"'})
    try:
        async with http_client(headers=headers, timeout=20) as c:
            r = await c.get(srv["url"].rstrip("/") + path)
    except httpx.HTTPError:
        raise HTTPException(502, "Server je nedostupný.")
    if r.status_code != 200:
        raise HTTPException(r.status_code, "Obrázek nedostupný.")
    return Response(r.content, media_type=r.headers.get("content-type", "image/jpeg"),
                    headers={"Cache-Control": "private, max-age=604800"})


# --- administration (login required) -----------------------------------------
@app.get("/api/settings", dependencies=authed)
async def get_settings():
    return settings_mod.masked(await settings_mod.load())


def _jw(s: dict) -> list[str]:
    """The services JustWatch is asked about (iVysílání has its own source)."""
    return sorted(queries.jw_providers(s["justwatch"].get("providers")))


@app.put("/api/settings", dependencies=authed)
async def put_settings(body: dict = Body(...)):
    before = await settings_mod.load()
    saved = await settings_mod.save(body)
    # start what the change made relevant, instead of waiting for the next scheduled run
    await manager.trigger_new_servers()
    if saved["justwatch"].get("enabled") and (
            _jw(saved) != _jw(before)
            or not before["justwatch"].get("enabled")):
        manager.trigger("justwatch")
    if ivysilani.selected(saved) and not ivysilani.selected(before):
        manager.trigger("ivysilani")
    sa_keys = ("enabled", "api_key", "catalogs", "mode")
    if saved["streaming_availability"].get("enabled") and any(
            saved["streaming_availability"].get(k) != before["streaming_availability"].get(k) for k in sa_keys):
        manager.trigger("sa")
    return settings_mod.masked(saved)


@app.post("/api/servers", dependencies=authed)
async def save_server(server: dict = Body(...)):
    """Add (no id) or update (with id) one media server; starts its sync when the connection changed."""
    try:
        srv, changed = await settings_mod.save_server(server)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if changed and srv.get("enabled", True):
        manager.trigger(f"server:{srv['id']}")
    return settings_mod.masked({"servers": [srv]})["servers"][0]


@app.delete("/api/servers/{server_id}", dependencies=authed)
async def delete_server(server_id: str):
    """Remove a server and everything it contributed to the catalogue."""
    removed = await settings_mod.delete_server(server_id)
    if not removed:
        raise HTTPException(404, "Server nenalezen.")
    await db.execute("DELETE FROM availability WHERE source=?", (f"{removed['type']}:{server_id}",))
    await db.execute("DELETE FROM sync_runs WHERE source=?", (f"server:{server_id}",))
    return {"ok": True}


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
        c = (country or s["country"]).upper()
        return {"items": await ivysilani.register(c, await justwatch.list_providers(c))}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"JustWatch nedostupný: {e}")


@app.get("/api/sync/status", dependencies=authed)
async def sync_status():
    return {"jobs": await manager.status(), "last_full": await db.kv_get("sync.last_full", 0),
            "running": bool(manager.running),
            "budgets": {n: await db.budget_used(n) for n in ("sa", "csfd", "mdblist", "omdb")}}


@app.get("/api/sync/progress", dependencies=viewers)
async def sync_progress():
    """Minimal: what is being downloaded right now (catalogue notice for every viewer)."""
    jobs = await manager.status()
    return {"running": [{"id": j["id"], "label": j["label"], "running": True,
                         "progress": {"phase": j["progress"]["phase"], "percent": j["progress"]["percent"]}}
                        for j in jobs if j["running"]],
            "queued": sum(1 for j in jobs if j["queued"]),
            "first": not await db.kv_get("sync.last_full", 0)}


@app.post("/api/ratings/focus", dependencies=viewers)
async def ratings_focus(body: dict = Body(...)):
    """The titles the viewer has on screen, in display order: their ratings are fetched first."""
    ids = [int(x) for x in (body.get("ids") or [])[:200] if str(x).isdigit()]
    await db.kv_set("ratings.focus", {"ids": ids, "v": time.time()})
    return {"ok": True}


@app.post("/api/sync", dependencies=authed)
async def sync_now(job: str | None = None):
    manager.trigger(job)
    return {"ok": True}


@app.get("/api/version")
async def api_version(refresh: bool = False):
    return await updates.status(VERSION, force=refresh)


@app.get("/api/health")
async def health():
    return {"ok": True}


# --- web UI -----------------------------------------------------------------
with open(os.path.join(STATIC, "index.html"), encoding="utf-8") as _f:
    # version in the asset URLs, so a new image never runs with a browser-cached old app.js/app.css
    INDEX_HTML = (_f.read()
                  .replace('href="/static/app.css"', f'href="/static/app.css?v={VERSION}"')
                  .replace('src="/static/i18n.js"', f'src="/static/i18n.js?v={VERSION}"')
                  .replace('src="/static/app.js"', f'src="/static/app.js?v={VERSION}"'))


@app.get("/")
async def index():
    return HTMLResponse(INDEX_HTML, headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=STATIC), name="static")
