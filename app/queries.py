"""Read side: search, catalogue browsing, title hydration."""

from __future__ import annotations

import json
from typing import Any

from .db import db
from .links import server_link
from .quality import QUALITY_ORDER, best_quality, merge_tags, norm

RATING_ORDER = ["csfd", "imdb", "rottentomatoes", "rottentomatoes_audience", "metacritic", "metacritic_user",
                "letterboxd", "tmdb", "trakt", "mdblist"]
SOURCE_PRIORITY = {"sa": 0, "justwatch": 1}  # whose link wins when both know the same offer


def _j(s: str | None) -> list:
    try:
        return json.loads(s) if s else []
    except ValueError:
        return []


async def hydrate(title_ids: list[int], link_ctx: dict | None = None) -> list[dict[str, Any]]:
    """link_ctx = {"servers": {id: server}, "lan": bool} rebuilds library links for the viewer."""
    if not title_ids:
        return []
    ph = ",".join("?" * len(title_ids))
    titles = {r["id"]: dict(r) for r in await db.fetchall(f"SELECT * FROM titles WHERE id IN ({ph})", title_ids)}
    ids: dict[int, dict] = {}
    for r in await db.fetchall(f"SELECT * FROM title_ids WHERE title_id IN ({ph})", title_ids):
        ids.setdefault(r["title_id"], {})[r["kind"]] = r["value"]
    ratings: dict[int, list] = {}
    for r in await db.fetchall(
            f"SELECT * FROM ratings WHERE title_id IN ({ph}) AND display IS NOT NULL", title_ids):
        ratings.setdefault(r["title_id"], []).append(
            {"source": r["source"], "display": r["display"], "value": r["value"], "votes": r["votes"], "url": r["url"]})
    where: dict[int, dict] = {}
    for r in await db.fetchall(f"SELECT * FROM availability WHERE title_id IN ({ph})", title_ids):
        groups = where.setdefault(r["title_id"], {})
        key = (r["provider"], r["monetization"])
        offer = {
            "provider": r["provider"], "provider_name": r["provider_name"], "kind": r["kind"],
            "monetization": r["monetization"], "quality": r["quality"], "video": _j(r["video"]),
            "audio": _j(r["audio"]), "audio_langs": _j(r["audio_langs"]), "subtitle_langs": _j(r["subtitle_langs"]),
            "url": r["url"], "expires_on": r["expires_on"], "sources": [r["source"]], "extra": json.loads(r["extra"] or "{}"),
        }
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
                        key=lambda o: (o["kind"] != "library", (o["provider_name"] or "").lower()))
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


async def catalog(provider: str | None = None, ttype: str | None = None, min_quality: str | None = None,
                  video: str | None = None, audio: str | None = None, lang: str | None = None,
                  sort: str = "imdb", order: str = "desc", page: int = 1, page_size: int = 50,
                  q: str | None = None, link_ctx: dict | None = None) -> dict:
    cond, params = [], []
    nq = norm(q or "")
    if provider:
        provs = [p for p in provider.split(",") if p]
        cond.append(f"a.provider IN ({','.join('?' * len(provs))})")
        params += provs
    if min_quality in QUALITY_ORDER:
        ok = [q for q, v in QUALITY_ORDER.items() if v >= QUALITY_ORDER[min_quality]]
        cond.append(f"a.quality IN ({','.join('?' * len(ok))})")
        params += ok
    if video:
        cond.append("a.video LIKE ?")
        params.append(f'%"{video}"%')
    if audio:
        cond.append("a.audio LIKE ?")
        params.append(f'%"{audio}"%')
    if lang:
        cond.append("a.audio_langs LIKE ?")
        params.append(f'%"{lang}"%')
    av = "SELECT 1 FROM availability a WHERE a.title_id=t.id" + "".join(f" AND {c}" for c in cond)
    where = f"WHERE EXISTS ({av})"
    if ttype:
        where += " AND t.type=?"
        params.append(ttype)
    if nq:
        where += " AND EXISTS (SELECT 1 FROM title_names n WHERE n.title_id=t.id AND n.norm LIKE ?)"
        params.append(f"%{nq}%")
    direction = "ASC" if order == "asc" else "DESC"
    if sort in ("title",):
        order_sql, join, jparams = f"t.title COLLATE NOCASE {direction}", "", []
    elif sort == "year":
        order_sql, join, jparams = f"t.year IS NULL, t.year {direction}", "", []
    else:
        order_sql = f"r.value IS NULL, r.value {direction}, t.year DESC"
        join, jparams = "LEFT JOIN ratings r ON r.title_id=t.id AND r.source=?", [sort]
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
    return {"titles": t["n"], "offers": o["n"], "ratings": r["n"]}
