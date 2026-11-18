"""Read side: search, catalogue browsing, title hydration."""

from __future__ import annotations

import json
from typing import Any

from . import settings as settings_mod
from .db import db
from .links import server_link
from .quality import QUALITY_ORDER, best_quality, merge_tags, norm

RATING_ORDER = ["csfd", "imdb", "tmdb", "tvmaze", "rottentomatoes", "rottentomatoes_audience", "metacritic",
                "metacritic_user", "letterboxd", "trakt", "mdblist"]
SOURCE_PRIORITY = {"sa": 0, "justwatch": 1}  # whose link wins when both know the same offer


def _j(s: str | None) -> list:
    try:
        return json.loads(s) if s else []
    except ValueError:
        return []


async def provider_rank() -> dict[str, int]:
    """Provider key -> position in the user's service order (settings), for sorting offers."""
    from . import settings as settings_mod
    order = (await settings_mod.load())["justwatch"].get("providers") or []
    keys = await db.kv_get("jw.provider_keys", {})
    return {keys.get(sn, sn): i for i, sn in enumerate(order)}


def rating_visible(cfg: dict):
    """Ratings stay stored when their source is switched off (ČSFD is slow to fetch again), they are only
    hidden: a rating source is shown when at least one enabled setting supplies it."""
    jw, mdb, omdb = cfg.get("justwatch_scores", True), bool(cfg.get("mdblist_api_key")), bool(cfg.get("omdb_api_key"))
    on = {
        "imdb": cfg.get("imdb_dataset", True) or jw or mdb or omdb,
        "csfd": cfg.get("csfd", False),
        "tmdb": bool(cfg.get("tmdb_api_key")) or jw or mdb,
        "tvmaze": cfg.get("tvmaze", True),
        "rottentomatoes": jw or mdb or omdb,
        "metacritic": mdb or omdb,
    }
    return lambda source: bool(on.get(source, mdb))


async def _visible() -> Any:
    return rating_visible((await settings_mod.load())["ratings"])


async def hydrate(title_ids: list[int], link_ctx: dict | None = None) -> list[dict[str, Any]]:
    """link_ctx = {"servers": {id: server}, "lan": bool} rebuilds library links for the viewer."""
    if not title_ids:
        return []
    rank = await provider_rank()
    ph = ",".join("?" * len(title_ids))
    titles = {r["id"]: dict(r) for r in await db.fetchall(f"SELECT * FROM titles WHERE id IN ({ph})", title_ids)}
    ids: dict[int, dict] = {}
    for r in await db.fetchall(f"SELECT * FROM title_ids WHERE title_id IN ({ph})", title_ids):
        ids.setdefault(r["title_id"], {})[r["kind"]] = r["value"]
    ratings: dict[int, list] = {}
    visible = await _visible()
    for r in await db.fetchall(
            f"SELECT * FROM ratings WHERE title_id IN ({ph}) AND display IS NOT NULL", title_ids):
        if not visible(r["source"]):
            continue
        ratings.setdefault(r["title_id"], []).append(
            {"source": r["source"], "display": r["display"], "value": r["value"], "votes": r["votes"], "url": r["url"]})
    icons = await db.kv_get("jw.provider_icons", {})
    where: dict[int, dict] = {}
    for r in await db.fetchall(f"SELECT * FROM availability WHERE title_id IN ({ph})", title_ids):
        groups = where.setdefault(r["title_id"], {})
        key = (r["provider"], r["monetization"])
        offer = {
            "provider": r["provider"], "provider_name": r["provider_name"], "kind": r["kind"],
            "monetization": r["monetization"], "quality": r["quality"], "video": _j(r["video"]),
            "audio": _j(r["audio"]), "audio_langs": _j(r["audio_langs"]), "subtitle_langs": _j(r["subtitle_langs"]),
            "url": r["url"], "expires_on": r["expires_on"], "added_at": r["added_at"],
            "sources": [r["source"]], "extra": json.loads(r["extra"] or "{}"),
        }
        if r["kind"] == "library" and ":" in r["source"]:
            # the server's own logo, through the backend (the internal address is not reachable from outside)
            offer["icon"] = f"/api/poster/{r['source'].split(':', 1)[1]}?path=%2Fweb%2Ffavicon.ico"
        else:
            offer["icon"] = offer["extra"].get("icon") or icons.get(r["provider"])
        if link_ctx and r["kind"] == "library" and ":" in r["source"]:
            srv = link_ctx["servers"].get(r["source"].split(":", 1)[1])
            if srv:
                offer["url"] = server_link(srv, offer["extra"], link_ctx["lan"]) or offer["url"]
        cur = groups.get(key)
        if not cur:
            groups[key] = offer
            continue
        # merge the same offer known from several sources (JustWatch + Streaming Availability)
        better_link = SOURCE_PRIORITY.get(r["source"], 9) < min(SOURCE_PRIORITY.get(s, 9) for s in cur["sources"])
        cur.update({
            "quality": best_quality(cur["quality"], offer["quality"]),
            "video": merge_tags(cur["video"], offer["video"]), "audio": merge_tags(cur["audio"], offer["audio"]),
            "audio_langs": merge_tags(cur["audio_langs"], offer["audio_langs"]),
            "subtitle_langs": merge_tags(cur["subtitle_langs"], offer["subtitle_langs"]),
            "expires_on": cur["expires_on"] or offer["expires_on"],
            "added_at": max(filter(None, (cur["added_at"], offer["added_at"])), default=None),
            "sources": cur["sources"] + offer["sources"],
            "extra": {**cur["extra"], **offer["extra"]},
        })
        if better_link and offer["url"]:
            cur["url"] = offer["url"]

    out = []
    for tid in title_ids:
        t = titles.get(tid)
        if not t:
            continue
        rs = sorted(ratings.get(tid, []),
                    key=lambda x: RATING_ORDER.index(x["source"]) if x["source"] in RATING_ORDER else 99)
        offers = sorted(where.get(tid, {}).values(),
                        key=lambda o: (o["kind"] != "library", rank.get(o["provider"], 999),
                                       (o["provider_name"] or "").lower()))
        out.append({
            "id": tid, "type": t["type"], "title": t["title"], "original_title": t["original_title"],
            "year": t["year"], "poster": t["poster"], "ids": ids.get(tid, {}), "ratings": rs, "where": offers,
        })
    return out


async def search(q: str, ttype: str | None = None, providers: list[str] | None = None, limit: int = 30,
                 link_ctx: dict | None = None) -> list[dict]:
    nq = norm(q)
    if not nq:
        return []
    sql =("SELECT t.id, t.year, MIN(n.norm) AS hit, "
           "MAX(n.norm = ?) AS exact, MAX(n.norm LIKE ?) AS prefix "
           "FROM titles t JOIN title_names n ON n.title_id=t.id WHERE n.norm LIKE ?")
    params: list[Any] = [nq, f"{nq}%", f"%{nq}%"]
    if ttype:
        sql += " AND t.type=?"
        params.append(ttype)
    av = "SELECT 1 FROM availability a WHERE a.title_id=t.id"
    if providers:
        av += f" AND a.provider IN ({','.join('?' * len(providers))})"
        params += providers
    sql += f" AND EXISTS ({av}) GROUP BY t.id ORDER BY exact DESC, prefix DESC, t.year DESC LIMIT ?"
    params.append(limit)
    rows = await db.fetchall(sql, params)
    return await hydrate([r["id"] for r in rows], link_ctx)


def _list(v: str | None) -> list[str]:
    """Comma-separated filter value -> list (empty items dropped)."""
    return [x.strip() for x in (v or "").split(",") if x.strip()]


async def catalog(provider: str | None = None, ttype: str | None = None, min_quality: str | None = None,
                  video: str | None = None, audio: str | None = None, lang: str | None = None,
                  sub: str | None = None, quality: str | None = None,
                  sort: str = "imdb", order: str = "desc", page: int = 1, page_size: int = 50,
                  q: str | None = None, link_ctx: dict | None = None) -> dict:
    cond, params = [], []
    nq = norm(q or "")
    if provider:
        provs = _list(provider)
        cond.append(f"a.provider IN ({','.join('?' * len(provs))})")
        params += provs
    quals = [x for x in _list(quality) if x in QUALITY_ORDER]
    if quals:
        cond.append(f"a.quality IN ({','.join('?' * len(quals))})")
        params += quals
    if min_quality in QUALITY_ORDER:
        ok = [q for q, v in QUALITY_ORDER.items() if v >= QUALITY_ORDER[min_quality]]
        cond.append(f"a.quality IN ({','.join('?' * len(ok))})")
        params += ok
    # several values in one filter = any of them (OR); different filters = all (AND), on the same offer
    for col, val in (("video", video), ("audio", audio), ("audio_langs", lang), ("subtitle_langs", sub)):
        vals = _list(val)
        if vals:
            cond.append("(" + " OR ".join(f"a.{col} LIKE ?" for _ in vals) + ")")
            params += [f'%"{v}"%' for v in vals]
    av = "SELECT 1 FROM availability a WHERE a.title_id=t.id" + "".join(f" AND {c}" for c in cond)
    where = f"WHERE EXISTS ({av})"
    types = [x for x in _list(ttype) if x in ("movie", "show")]
    if len(types) == 1:
        where += " AND t.type=?"
        params.append(types[0])
    if nq:
        where += " AND EXISTS (SELECT 1 FROM title_names n WHERE n.title_id=t.id AND n.norm LIKE ?)"
        params.append(f"%{nq}%")
    direction = "ASC" if order == "asc" else "DESC"
    if sort in ("title",):
        order_sql, join, jparams = f"t.title COLLATE NOCASE {direction}", "", []
    elif sort == "year":
        order_sql, join, jparams = f"t.year IS NULL, t.year {direction}, t.title COLLATE NOCASE", "", []
    elif sort == "added":
        # when the platform/library added it (only some sources know); restricted to the chosen services
        prov_cond = ""
        if provider:
            provs = [p for p in provider.split(",") if p]
            prov_cond = f" AND a.provider IN ({','.join('?' * len(provs))})"
        join = (f"LEFT JOIN (SELECT a.title_id, MAX(a.added_at) AS added FROM availability a "
                f"WHERE a.added_at IS NOT NULL{prov_cond} GROUP BY a.title_id) ad ON ad.title_id=t.id")
        jparams = [p for p in provider.split(",") if p] if provider else []
        order_sql = f"ad.added IS NULL, ad.added {direction}, t.year DESC"
    else:
        # sorted by a rating: only titles that have it (the rest would only pile up at the end)
        order_sql = f"r.value {direction}, r.votes DESC, t.year DESC"
        join, jparams = "JOIN ratings r ON r.title_id=t.id AND r.source=? AND r.value IS NOT NULL", [sort]
        where += " AND EXISTS (SELECT 1 FROM ratings rr WHERE rr.title_id=t.id AND rr.source=? AND rr.value IS NOT NULL)"
        params.append(sort)
    if nq:
        # search: exact name first, then names starting with the query, then the chosen sort
        rel = ("(SELECT MAX(n.norm = ?) FROM title_names n WHERE n.title_id=t.id) DESC, "
               "(SELECT MAX(n.norm LIKE ?) FROM title_names n WHERE n.title_id=t.id) DESC, ")
        order_sql = rel + order_sql
        order_params = [nq, f"{nq}%"]
    else:
        order_params = []
    total = (await db.fetchone(f"SELECT COUNT(*) AS n FROM titles t {where}", params))["n"]
    page_size = max(1, min(page_size, 200))
    rows = await db.fetchall(
        f"SELECT t.id FROM titles t {join} {where} ORDER BY {order_sql} LIMIT ? OFFSET ?",
        jparams + params + order_params + [page_size, (max(page, 1) - 1) * page_size])
    return {"total": total, "page": page, "page_size": page_size,
            "items": await hydrate([r["id"] for r in rows], link_ctx)}


async def providers() -> list[dict]:
    rows = await db.fetchall(
        "SELECT provider, MAX(provider_name) AS name, kind, COUNT(DISTINCT title_id) AS titles "
        "FROM availability GROUP BY provider, kind ORDER BY kind DESC, name COLLATE NOCASE")
    return [dict(r) for r in rows]


async def stats() -> dict:
    t = await db.fetchone("SELECT COUNT(*) AS n FROM titles t WHERE EXISTS "
                          "(SELECT 1 FROM availability a WHERE a.title_id=t.id)")
    o = await db.fetchone("SELECT COUNT(*) AS n FROM availability")
    r = await db.fetchone("SELECT COUNT(*) AS n FROM ratings WHERE display IS NOT NULL")
    src = await db.fetchall("SELECT DISTINCT source FROM availability")
    return {"titles": t["n"], "offers": o["n"], "ratings": r["n"], "sources": sorted(x["source"] for x in src)}


async def facets() -> dict:
    """Values that actually occur in the catalogue, with title counts, for the filter menus."""
    async def tags(col: str) -> list[dict]:
        rows = await db.fetchall(
            f"SELECT j.value AS v, COUNT(DISTINCT a.title_id) AS n FROM availability a, json_each(a.{col}) j "
            "WHERE j.value IS NOT NULL AND j.value != '' GROUP BY j.value ORDER BY n DESC")
        return [{"value": r["v"], "titles": r["n"]} for r in rows]
    visible = await _visible()
    ratings = [r for r in await db.fetchall(
        "SELECT source, COUNT(*) AS n FROM ratings WHERE display IS NOT NULL GROUP BY source ORDER BY n DESC")
        if visible(r["source"])]
    q = await db.fetchall("SELECT quality AS v, COUNT(DISTINCT title_id) AS n FROM availability "
                          "WHERE quality IS NOT NULL GROUP BY quality")
    added = await db.fetchone("SELECT COUNT(DISTINCT title_id) AS n FROM availability WHERE added_at IS NOT NULL")
    return {
        "quality": sorted(({"value": r["v"], "titles": r["n"]} for r in q),
                          key=lambda x: -QUALITY_ORDER.get(x["value"], 0)),
        "with_added_date": added["n"],
        "audio_langs": await tags("audio_langs"),
        "subtitle_langs": await tags("subtitle_langs"),
        "video": await tags("video"),
        "audio": await tags("audio"),
        "ratings": [{"value": r["source"], "titles": r["n"]} for r in ratings],
    }
