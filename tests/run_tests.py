"""Offline end-to-end test: mock servers + in-process app."""

import asyncio
import os
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ["DATA_DIR"] = tempfile.mkdtemp()
os.environ["DISABLE_SCHEDULER"] = "1"

import uvicorn  # noqa: E402
from simplejustwatchapi import query as jwq  # noqa: E402

from tests import mock_servers  # noqa: E402

PORT = 9911
BASE = f"http://127.0.0.1:{PORT}"


def start_mock():
    cfg = uvicorn.Config(mock_servers.app, port=PORT, log_level="warning")
    srv = uvicorn.Server(cfg)
    threading.Thread(target=srv.run, daemon=True).start()
    for _ in range(50):
        if srv.started:
            return
        time.sleep(0.1)


# ---------------- fake JustWatch ----------------
def jw_node(i, year, otype="MOVIE", title=None, imdb=None, offers=None):
    return {
        "id": f"tm{i}", "objectId": i, "objectType": otype,
        "content": {"title": title or f"Film {i}", "fullPath": f"/cz/film/f{i}", "originalReleaseYear": year,
                    "externalIds": {"imdbId": imdb, "tmdbId": None},
                    "scoring": {"imdbScore": 8.6, "imdbVotes": 100, "tmdbScore": 8.2, "tomatoMeter": 83}},
        "offers": offers if offers is not None else [{
            "id": f"o{i}", "monetizationType": "FLATRATE", "presentationType": "_4K", "standardWebURL": f"https://www.netflix.com/title/{i}",
            "package": {"id": "p8", "packageId": 8, "clearName": "Netflix", "technicalName": "netflix", "shortName": "nfx"},
            "videoTechnology": ["DOLBY_VISION"], "audioTechnology": ["DOLBY_ATMOS"],
            "audioLanguages": ["cs", "en"], "subtitleLanguages": ["cs"],
        }],
    }


CATALOG = [jw_node(1, 1999, title="Matrix", imdb="tt0133093")]
CATALOG[0]["offers"].append({
    "id": "oo", "monetizationType": "FLATRATE", "presentationType": "HD", "standardWebURL": "https://www.oneplay.cz/x",
    "package": {"id": "p9", "packageId": 9, "clearName": "Oneplay", "technicalName": "oneplay", "shortName": "opl"},
    "videoTechnology": [], "audioTechnology": [], "audioLanguages": ["cs"], "subtitleLanguages": []})
CATALOG[0]["offers"].append({  # not subscribed -> ignored
    "id": "ox", "monetizationType": "FLATRATE", "presentationType": "HD", "standardWebURL": "https://x",
    "package": {"id": "p10", "packageId": 10, "clearName": "MUBI", "technicalName": "mubi", "shortName": "mub"}})
CATALOG += [jw_node(1000 + i, 2010 + (i % 5)) for i in range(2500)]           # forces window split
CATALOG += [jw_node(9000, 2019, otype="SHOW", title="Černobyl", imdb="tt7366338")]
JW_CALLS = []


def fake_popular(country, language, count, best_only, offset, providers, lo, hi, otype):
    JW_CALLS.append((providers, otype, lo, hi, offset, count))
    assert count + offset < 2000
    items = [n for n in CATALOG if n["objectType"] == otype and lo <= n["content"]["originalReleaseYear"] <= hi
             and any(o["package"]["shortName"] == providers for o in n["offers"])]
    if len(items) > 1999:
        items = items[:1999]
    return [jwq._parse_entry(n) for n in items[offset:offset + count]]


def fake_details(node_id, country, language, best_only):
    node = next((n for n in CATALOG if n["id"] == node_id), None)
    if node is None:
        raise RuntimeError("JustWatch: no such node")
    return jwq._parse_entry(node)


def fake_search(title, country, language, count, best_only):
    return [jwq._parse_entry(n) for n in CATALOG if title.lower() in n["content"]["title"].lower()][:count]


def fake_providers(country):
    return [jwq._parse_package({"id": "p8", "packageId": 8, "clearName": "Netflix", "technicalName": "netflix",
                                "shortName": "nfx", "monetizationTypes": ["FLATRATE"], "icon": "/i.png"}),
            jwq._parse_package({"id": "p9", "packageId": 9, "clearName": "Oneplay", "technicalName": "oneplay",
                                "shortName": "opl", "monetizationTypes": ["FLATRATE"]}),
            jwq._parse_package({"id": "p1", "packageId": 1, "clearName": "Apple TV Store", "technicalName": "itunes",
                                "shortName": "itu", "monetizationTypes": ["RENT", "BUY"]})]


def main():
    start_mock()
    import json, sqlite3
    from app import ratings, settings as S
    from app.db import DB_PATH
    from app.sources import justwatch, streaming_availability
    from app.main import app
    from fastapi.testclient import TestClient

    justwatch.jw.popular = fake_popular
    justwatch.jw.providers = fake_providers
    justwatch.jw.details = fake_details
    justwatch.jw.search = fake_search
    justwatch.PAGE = 200
    streaming_availability.DIRECT_BASE = f"{BASE}/sa"
    ratings.IMDB_RATINGS_URL = f"{BASE}/imdb/title.ratings.tsv.gz"
    ratings.CSFD = f"{BASE}/csfd"
    ratings.CSFD_DELAY_S = 0
    ratings.TMDB_API = f"{BASE}/tmdb"
    ratings.TVMAZE_API = f"{BASE}/tvmaze"
    ratings.OMDB_API = f"{BASE}/omdb/"

    def sql(q):
        con = sqlite3.connect(DB_PATH)
        try:
            return con.execute(q).fetchall()
        finally:
            con.close()

    def sql_exec(q):
        con = sqlite3.connect(DB_PATH)
        try:
            con.execute(q)
            con.commit()
        finally:
            con.close()

    def run_sync(client, job=None):
        t0 = time.time()
        client.post("/api/sync", params={"job": job} if job else None)
        time.sleep(0.3)
        for _ in range(900):
            st = client.get("/api/sync/status").json()
            jobs = [j for j in st["jobs"] if not job or j["id"] == job]
            if not st["running"] and not any(j["queued"] for j in st["jobs"]) and all(
                    j["last"] and j["last"]["status"] != "running" and j["last"]["finished_at"] >= t0 - 30 for j in jobs):
                return st
            time.sleep(0.2)
        raise TimeoutError

    with TestClient(app) as client:
        # ---- auth ----
        # version badge: newer tag on GitHub -> update, unreachable -> unknown
        from app import updates
        async def newer(): return "1.0.7"
        async def offline(): raise RuntimeError("offline")
        updates._latest_tag, updates._cache["at"] = newer, 0
        v = client.get("/api/version").json()
        assert v["latest"] == "1.0.7" and v["state"] == "unknown", v   # running "dev" cannot be compared
        assert client.get("/").text.count("?v=") == 3 and client.get("/").headers["cache-control"] == "no-cache"
        # UI translations: every language file is served and has exactly the Czech key set
        import glob as _g, re as _re
        cs_keys = client.get("/static/i18n/cs.json").json()
        lang_files = sorted(_g.glob(os.path.join(os.path.dirname(__file__), "..", "app", "static", "i18n", "*.json")))
        assert len(lang_files) >= 20, len(lang_files)
        for lf in lang_files:
            code = os.path.basename(lf)[:-5]
            d = client.get(f"/static/i18n/{code}.json").json()
            assert set(d) == set(cs_keys), (code, set(cs_keys) ^ set(d))
            for k, v in cs_keys.items():
                assert set(_re.findall(r"\{\w+\}", v)) == set(_re.findall(r"\{\w+\}", d[k])), (code, k)
        js = client.get("/static/i18n.js").text
        assert all(f'"{os.path.basename(lf)[:-5]}"' in js for lf in lang_files)
        # a release published after the last check must turn the badge red within CHECK_EVERY_S
        async def v101(): return "1.0.1"
        async def v102(): return "1.0.2"
        updates._latest_tag, updates._cache["at"] = v101, 0
        # JustWatch offer dates: the popular query asks for dateCreated and the raw answer's dates are kept by offer id
        from app.sources import justwatch as jwsrc
        req = jwsrc.jw.prepare_popular_request("CZ", "cs", 2, True, 0, ["nfx"], None, None, None)
        assert "dateCreated" in req["query"]
        jwsrc._collect_dates({"data": {"x": [{"__typename": "Offer", "id": "o1", "dateCreated": "2026-11-02T10:00:00Z"}]}})
        assert jwsrc._OFFER_DATES.pop("o1") == "2026-11-02T10:00:00"
        # a service under its own name, not JustWatch's spelling
        from app.quality import provider_name
        assert provider_name("Prima plus") == "Prima+" and provider_name("Netflix") == "Netflix"
        # the ČSFD id of an Emby plugin, whatever the plugin calls it and however it writes it
        from app.sources.emby import _ids as emby_ids
        for key, val in (("ČSFD", "1580037"), ("Csfd", "1580037-odyssea"), ("csfd.cz", "https://www.csfd.cz/film/1580037-odyssea/")):
            assert emby_ids({key: val}, "movie")["csfd"] == "1580037", (key, val)
        # two films of the same name and year: a library film and a catalogue film with other IMDb ids stay apart;
        # a catalogue entry that was joined to the library film earlier leaves it (with the ratings it brought)
        from app import store as st_mod
        from app.db import db

        async def odyssea():
            lib = await st_mod.upsert_title(st_mod.TitleInfo("movie", "Odyssea X", year=2026, library=True,
                                            ids={"imdb": "tt9990001", "tmdb_movie": "9001", "tvdb": "77", "csfd": "123"}))
            await st_mod.upsert_offer(lib, st_mod.Offer(source="emby:x", provider="emby-x", provider_name="Emby", kind="library",
                                                         monetization="library"), time.time())
            other = await st_mod.upsert_title(st_mod.TitleInfo("movie", "Odyssea X", year=2026,
                                              ids={"imdb": "tt9990002", "tmdb_movie": "9002", "jw": "tm999"}))
            # the old state: the catalogue entry joined to the library film
            await db.execute("DELETE FROM title_ids WHERE kind='jw' AND value='tm999'")
            await db.execute("INSERT INTO title_ids(kind, value, title_id) VALUES('jw','tm999',?)", (lib,))
            await db.execute("INSERT OR REPLACE INTO ratings(title_id, source, value, display, updated_at) VALUES(?, 'tmdb', 10, '1.0', 0)", (lib,))
            again = await st_mod.upsert_title(st_mod.TitleInfo("movie", "Odyssea X", year=2026,
                                              ids={"imdb": "tt9990002", "tmdb_movie": "9002", "jw": "tm999"}))
            rows = await db.fetchall("SELECT source FROM ratings WHERE title_id=?", (lib,))
            return lib, other, again, [r["source"] for r in rows]
        lib, other, again, left = client.portal.call(odyssea)   # in the app's own event loop (its database)
        assert other != lib and again != lib and "tmdb" not in left, (lib, other, again, left)

        # ČSFD: a revival of a long-running series is found under the original series, if its years reach it
        import httpx

        async def scrubs():
            async with httpx.AsyncClient(headers={"User-Agent": "test"}) as c:
                return (await ratings.csfd_find(c, "Scrubs", 2026, "show"), await ratings.csfd_find(c, "Scrubs", 2026),
                        await ratings.csfd_rating(c, "777"))
        show, movie, (value, _votes, _url, _imdb, years, _fy) = asyncio.run(scrubs())
        assert show == ("777", True) and movie is None and value == 81 and years == (2001, 2026), (show, movie, value, years)
        assert asyncio.run(updates.status("1.0.1"))["state"] == "current"
        updates._latest_tag = v102
        updates._cache["at"] -= updates.CHECK_EVERY_S + 1
        assert asyncio.run(updates.status("1.0.1"))["state"] == "update"
        assert updates.CHECK_EVERY_S <= 5 * 60
        # opening the page forces a check once the last one is older than a minute
        async def v103(): return "1.0.3"
        updates._latest_tag, updates._cache["at"] = v101, 0
        assert asyncio.run(updates.status("1.0.1"))["state"] == "current"
        updates._latest_tag = v103
        updates._cache["at"] -= updates.FORCE_MIN_S + 1
        assert asyncio.run(updates.status("1.0.1"))["state"] == "current"          # not due yet
        assert asyncio.run(updates.status("1.0.1", force=True))["state"] == "update"  # page open/focus
        updates._latest_tag, updates._cache["at"] = offline, 0
        assert client.get("/api/version").json()["state"] == "unknown"

        # nothing without a login: neither the catalogue (the server may be reachable from outside) nor the administration
        for path in ("/api/search?q=x", "/api/catalog", "/api/stats", "/api/sync/progress",
                     "/api/settings", "/api/sync/status", "/api/auth/token", "/api/justwatch/providers"):
            assert client.get(path).status_code == 401, path
        assert client.post("/api/sync").status_code == 401
        from app.sources.base import SyncContext
        c = SyncContext("x", {})
        c.progress("a", 0.5)
        assert c.percent == 50
        c.step(1, 4)
        assert c.percent == 25
        c.progress("b", 0.5)
        assert c.percent == 37
        c.progress("c")
        assert c.percent == 37 and c.phase == "c"
        c.step(3, 4)
        c.progress("d", 1.0)
        assert c.percent == 99   # 100 % only when the job is really finished
        assert client.put("/api/settings", json={}).status_code == 401
        assert client.get("/api/auth/state").json()["configured"] is False
        assert client.post("/api/auth/setup", json={"password": "short"}).status_code == 400
        assert client.post("/api/auth/setup", json={"password": "heslo1234"}).status_code == 200
        assert client.post("/api/auth/setup", json={"password": "heslo1234"}).status_code == 409
        # first run: setup wizard pending, ČSFD opt-in on a fresh install
        assert client.get("/api/onboarding").json() == {"pending": True}
        # sync progress (catalogue notice) is minimal
        pr = client.get("/api/sync/progress").json()
        assert pr == {"running": [], "queued": 0, "first": True}, pr
        assert client.get("/api/settings").json()["ratings"]["csfd"] is False
        assert client.post("/api/onboarding/done").status_code == 200
        assert client.get("/api/onboarding").json() == {"pending": False}
        assert client.get("/api/auth/state").json()["logged_in"] is True
        token = client.get("/api/auth/token").json()["token"]

        # ---- settings ----
        body = {
            "justwatch": {"enabled": True, "providers": ["nfx", "opl"], "request_delay_s": 0},
            "streaming_availability": {"enabled": True, "api_key": "sakey", "catalogs": ["netflix"], "daily_budget": 50},
            "servers": [
                {"type": "emby", "name": "Emby doma", "url": f"{BASE}/emby", "public_url": "https://emby.example.cz", "token": "embykey"},
                {"type": "jellyfin", "name": "Jellyfin", "url": f"{BASE}/emby", "token": "embykey"},
                {"type": "plex", "name": "Plex", "url": f"{BASE}/plex", "token": "plextoken"},
            ],
            "ratings": {"csfd": True, "imdb_dataset": True, "csfd_daily_budget": 20,
                        "tmdb_api_key": "tmdbkey", "omdb_api_key": "omdbkey", "tvmaze": True},
        }
        r = client.put("/api/settings", json=body).json()
        time.sleep(0.5)
        st = client.get("/api/sync/status").json()
        started = {j["id"] for j in st["jobs"] if j["running"] or j["last"]}
        assert "justwatch" in started and sum(1 for j in started if j.startswith("server:")) == 3, st
        running = [j for j in st["jobs"] if j["running"]]
        assert all("phase" in j["progress"] and "items" in j["progress"] for j in running), running
        assert r["streaming_availability"]["api_key"] == S.MASK
        assert all(s["token"] == S.MASK for s in r["servers"])
        # masked secrets survive a round trip
        r = client.put("/api/settings", json=r).json()
        stored = json.loads(sql("SELECT value FROM kv WHERE key='settings'")[0][0])
        assert stored["streaming_availability"]["api_key"] == "sakey"
        assert [s["token"] for s in stored["servers"]] == ["embykey", "embykey", "plextoken"]
        emby_id, jf_id, plex_id = [s["id"] for s in stored["servers"]]

        t = client.post("/api/servers/test", json={**r["servers"][0]}).json()
        assert t["ok"] and t["info"]["name"] == "Emby doma", t
        t = client.post("/api/servers/test", json={"type": "emby", "url": f"{BASE}/emby", "token": "bad"}).json()
        assert not t["ok"]
        prov = client.get("/api/justwatch/providers").json()["items"]
        # rent/buy-only store filtered out; iVysílání (own source) is offered in Czechia
        assert [p["short_name"] for p in prov] == ["ivy", "nfx", "opl"], prov

        # ---- run all syncs ----
        run_sync(client)
        status = {j["id"]: j["last"] for j in client.get("/api/sync/status").json()["jobs"]}
        for jid, last in status.items():
            print(f"  {jid:22} {last['status']:8} items={last['items']}  {(last['message'] or '')[:90]!r}")
        assert all(l["status"] == "ok" for k, l in status.items() if k != "ratings"), status
        assert status["ratings"]["status"] in ("ok", "partial")  # ČSFD budget deliberately small
        assert client.get("/api/sync/progress").json()["first"] is False
        # two works of the same name: an entry sharing one id but disagreeing on another stays apart
        from app import store as st
        async def mixing():
            drama = await st.upsert_title(st.TitleInfo(type="show", title="Zrádci", year=2020,
                                                       ids={"jw": "tsX1", "tmdb_tv": "97547"}))
            reality = await st.upsert_title(st.TitleInfo(type="show", title="Zrádci", year=2024,
                                                         ids={"imdb": "tt33321873", "tmdb_tv": "271587", "csfd": "1714308"}))
            bridge = await st.upsert_title(st.TitleInfo(type="show", title="Zrádci", year=2024,
                                                        ids={"tmdb_tv": "97547", "imdb": "tt33321873"}))
            close = await st.upsert_title(st.TitleInfo(type="show", title="Zrádci", year=2021,
                                                       ids={"tmdb_tv": "97547", "imdb": "tt10720694"}))
            return drama, reality, bridge, close
        drama, reality, bridge, close = client.portal.call(mixing)
        assert len({drama, reality, bridge}) == 3, (drama, reality, bridge)   # bridge disagrees with both
        assert close == drama                                                # same work, ids complement
        sql_exec(f"INSERT INTO title_ids(kind, value, title_id) VALUES('tmdb_tv', '999999', {reality})")
        assert client.portal.call(st.repair_mixed_titles) == 1
        # catalogue first, library second (the usual order of a new installation): the library's id wins
        async def library_wins():
            jw = await st.upsert_title(st.TitleInfo(type="show", title="Hra", year=2019,
                                                    ids={"jw": "tsY1", "imdb": "tt9000001", "tmdb_tv": "555"}))
            await st.set_rating(jw, "imdb", 83, "8.3")
            lib = await st.upsert_title(st.TitleInfo(type="show", title="Hra", year=2025, library=True,
                                                     ids={"imdb": "tt9000001", "tmdb_tv": "777"}))
            return jw, lib
        jw_t, lib_t = client.portal.call(library_wins)
        assert jw_t != lib_t
        assert sql("SELECT title_id FROM title_ids WHERE kind='imdb' AND value='tt9000001'") == [(lib_t,)]
        assert not sql(f"SELECT 1 FROM ratings WHERE title_id={jw_t}")   # that rating belonged to the other work
        assert client.portal.call(st.repair_mixed_titles) == 0
        # switched-off rating sources are hidden (kept stored)
        from app.queries import rating_visible
        off = rating_visible({"imdb_dataset": False, "justwatch_scores": False, "csfd": False, "tvmaze": False})
        assert not any(off(x) for x in ("imdb", "csfd", "tmdb", "tvmaze", "rottentomatoes", "letterboxd"))
        assert rating_visible({"csfd": True, "justwatch_scores": False, "imdb_dataset": False})("csfd")
        assert not sql(f"SELECT 1 FROM titles WHERE id={reality}") and sql(f"SELECT 1 FROM titles WHERE id={drama}")
        assert "justwatch" in client.get("/api/stats").json()["sources"]

        # JustWatch window splitting: 2010-2014 window had 2500 titles -> must be split, nothing lost
        n = sql("SELECT COUNT(DISTINCT title_id) FROM availability WHERE source='justwatch' AND provider='netflix'")[0][0]
        assert n == 2502, n
        assert any(c[2] == 2010 and c[3] == 2012 for c in JW_CALLS), "window was not split"

        # catalogue logos: streaming services from JustWatch, own servers from the server itself
        mx = client.get("/api/search", params={"q": "matrix"}).json()["items"][0]
        libs = [o for o in mx["where"] if o["kind"] == "library"]
        assert libs and all(o["icon"].endswith("?path=%2Fweb%2Ffavicon.ico") for o in libs), libs
        assert any(o["kind"] == "stream" and o["icon"] for o in mx["where"]), mx["where"]
        assert client.get("/api/poster/none?path=/web/other.js").status_code == 400

        # services in the user's order (priority), newest titles first
        order = [c[0] for c in JW_CALLS]
        prov_order = list(dict.fromkeys(order))
        # services are fetched at the same time (started in the user's order), so their requests interleave
        wanted = json.loads(sql("SELECT value FROM kv WHERE key='settings'")[0][0])["justwatch"]["providers"]
        assert set(prov_order) == set(wanted), prov_order
        assert JW_CALLS[0][2] > 2025, JW_CALLS[0]

        # an interrupted run continues where it stopped
        justwatch.RETRY_SCALE = 0
        real_popular, calls = justwatch.jw.popular, {"n": 0}
        def flaky(*a):
            calls["n"] += 1
            if calls["n"] > 6:
                raise ConnectionError("error sending request for url")
            return real_popular(*a)
        justwatch.jw.popular = flaky
        JW_CALLS.clear()
        st_run = run_sync(client, "justwatch")
        jw_last = next(j for j in st_run["jobs"] if j["id"] == "justwatch")["last"]
        assert jw_last["status"] == "error" and "naváže" in jw_last["message"], jw_last
        assert sql("SELECT 1 FROM kv WHERE key='jw.resume'")
        first = list(JW_CALLS)
        justwatch.jw.popular = real_popular
        JW_CALLS.clear()
        st_run = run_sync(client, "justwatch")
        jw_last = next(j for j in st_run["jobs"] if j["id"] == "justwatch")["last"]
        assert jw_last["status"] == "ok" and "Navazuji" in jw_last["message"], jw_last
        repeated = [c for c in first if c in JW_CALLS]
        assert len(repeated) <= 1, repeated          # only the request that was running when it broke
        assert not sql("SELECT 1 FROM kv WHERE key='jw.resume'")
        n = sql("SELECT COUNT(DISTINCT title_id) FROM availability WHERE source='justwatch' AND provider='netflix'")[0][0]
        assert n == 2502, n

        # SA cursor walk
        cursors = [c.get("cursor") for c in mock_servers.SA_CALLS if c["show_type"] == "movie"]
        assert cursors and cursors == [None, "c2"] * (len(cursors) // 2), cursors  # each walk: page 1, then cursor

        # ---- search ----
        items = client.get("/api/search", params={"q": "matrix"}).json()["items"]
        assert len(items) == 1, [i["title"] for i in items]
        m = items[0]
        print("  Matrix ->", [(o["provider_name"], o["quality"], o["video"], o["audio"], o["sources"]) for o in m["where"]])
        print("  ratings ->", [(x["source"], x["display"]) for x in m["ratings"]])
        provs = {o["provider"]: o for o in m["where"]}
        assert set(provs) == {f"emby-{emby_id}", f"jellyfin-{jf_id}", f"plex-{plex_id}", "netflix", "oneplay"}, set(provs)
        nf = provs["netflix"]
        assert sorted(nf["sources"]) == ["justwatch", "sa"]
        assert nf["url"] == "https://www.netflix.com/watch/20557937"  # SA deep link wins
        assert nf["quality"] == "UHD" and "DV" in nf["video"] and "Atmos" in nf["audio"]
        assert "mubi" not in provs
        em = provs[f"emby-{emby_id}"]
        assert em["quality"] == "UHD" and em["video"][:1] == ["DV"] and "Atmos" in em["audio"] and "TrueHD" in em["audio"]
        assert em["audio_langs"] == ["en", "cs", "de"] and em["subtitle_langs"] == ["cs", "en"], em   # both copies
        assert em["url"] == "https://emby.example.cz/web/index.html#!/item?id=m1&serverId=srv123"       # better copy
        assert provs[f"jellyfin-{jf_id}"]["url"].endswith("/web/#/details?id=m1&serverId=srv123")
        assert provs[f"plex-{plex_id}"]["quality"] == "FHD"
        assert provs[f"plex-{plex_id}"]["url"].startswith("https://app.plex.tv/desktop/#!/server/plexmachine/details?key=%2Flibrary%2Fmetadata%2F102")
        rt = {x["source"]: x["display"] for x in m["ratings"]}
        assert rt["imdb"] == "8.7" and rt["csfd"] == "91 %" and rt["rottentomatoes"] == "88 %", rt   # OMDb (newer) over JustWatch
        assert m["ids"]["csfd"] == "9499"
        od = client.get("/api/search", params={"q": "odyssea"}).json()["items"][0]
        od_lib = next(o for o in od["where"] if o["provider"] == f"emby-{emby_id}")
        assert od_lib["audio_langs"] == ["en", "cs"], od_lib     # the Czech track of the second version

        # the ČSFD id from the Emby plugin wins over one our own ČSFD search found (wrong film): replaced, rating refetched
        mid = m["id"]
        sql_exec(f"UPDATE title_ids SET value='1111' WHERE title_id={mid} AND kind='csfd'")
        sql_exec(f"UPDATE ratings SET display='10 %' WHERE title_id={mid} AND source='csfd'")
        run_sync(client, f"server:{emby_id}")
        assert sql(f"SELECT value FROM title_ids WHERE title_id={mid} AND kind='csfd'") == [("9499",)]
        # offers follow the user's service order (reordering does not start a sync)
        def stream_order():
            item = client.get("/api/catalog", params={"q": "matrix"}).json()["items"][0]
            return [o["provider"] for o in item["where"] if o["kind"] != "library"]
        client.get("/api/justwatch/providers")            # learns short name -> provider key
        assert stream_order() == ["netflix", "oneplay"], stream_order()
        client.put("/api/settings", json={"justwatch": {"providers": ["opl", "nfx"]}})
        assert stream_order() == ["oneplay", "netflix"], stream_order()
        assert not client.get("/api/sync/status").json()["running"]
        client.put("/api/settings", json={"justwatch": {"providers": ["nfx", "opl"]}})
        sql_exec("DELETE FROM kv WHERE key LIKE 'budget:csfd:%'")
        run_sync(client, "ratings")
        assert sql(f"SELECT display FROM ratings WHERE title_id={mid} AND source='csfd'") == [("91 %",)]

        # two films of one name and year on ČSFD: the page whose IMDb id is another film's is not taken, the
        # stored wrong ČSFD id is dropped and kept from coming back, the right one is found
        async def twins():
            tid = await st_mod.upsert_title(st_mod.TitleInfo("movie", "Dvojník", year=2026, ids={"imdb": "tt8000002", "csfd": "8001"}))
            await st_mod.upsert_offer(tid, st_mod.Offer(source="netflix", provider="netflix", provider_name="Netflix", kind="stream",
                                                         monetization="flatrate"), time.time())
            return tid
        from app import store as st_mod
        twin = client.portal.call(twins)
        sql_exec("DELETE FROM kv WHERE key LIKE 'budget:csfd:%'")
        run_sync(client, "ratings")
        assert sql(f"SELECT value FROM title_ids WHERE title_id={twin} AND kind='csfd'") == [("8002",)]
        assert sql(f"SELECT display FROM ratings WHERE title_id={twin} AND source='csfd'") == [("77 %",)]
        assert "8001|tt8000002" in json.loads(sql("SELECT value FROM kv WHERE key='csfd.rejected'")[0][0])
        # the user's library (an Emby ČSFD plugin) names the page: that one is final, even one the search had
        # rejected; the ratings take exactly it (no search, no IMDb check)
        client.portal.call(lambda: st_mod.upsert_title(st_mod.TitleInfo("movie", "Dvojník", year=2026, library=True,
                                                       ids={"imdb": "tt8000002", "csfd": "8001"}, authoritative=("csfd",))))
        assert sql(f"SELECT value FROM title_ids WHERE title_id={twin} AND kind='csfd'") == [("8001",)]
        r = client.post(f"/api/titles/{twin}/refresh")
        assert {x["source"]: x["display"] for x in r.json()["ratings"]}.get("csfd") == "33 %", r.json()["ratings"]
        assert sql(f"SELECT value FROM title_ids WHERE title_id={twin} AND kind='csfd'") == [("8001",)]
        # refresh one title (the button on the title): ČSFD at once; a ČSFD page without any IMDb link loses to a
        # candidate whose page has the title's own IMDb id
        async def trio():
            tid = await st_mod.upsert_title(st_mod.TitleInfo("movie", "Trojice", year=2026, ids={"imdb": "tt9100002", "csfd": "9101"}))
            await st_mod.upsert_offer(tid, st_mod.Offer(source="netflix", provider="netflix", provider_name="Netflix", kind="stream",
                                                         monetization="flatrate"), time.time())
            return tid
        three = client.portal.call(trio)
        r = client.post(f"/api/titles/{three}/refresh")
        assert r.status_code == 200, r.text
        assert {x["source"]: x["display"] for x in r.json()["ratings"]}.get("csfd") == "64 %", r.json()["ratings"]
        assert sql(f"SELECT value FROM title_ids WHERE title_id={three} AND kind='csfd'") == [("9102",)]
        # the page without an IMDb link that lost is remembered as another film
        assert "9101|tt9100002" in json.loads(sql("SELECT value FROM kv WHERE key='csfd.rejected'")[0][0])
        assert client.get("/api/sync/status").status_code == 200
        # a stored ČSFD id (the library's) of a film of another year is dropped, the search finds the right one
        async def rok():
            tid = await st_mod.upsert_title(st_mod.TitleInfo("movie", "Rok", year=2026, ids={"csfd": "9201"}))
            await st_mod.upsert_offer(tid, st_mod.Offer(source="netflix", provider="netflix", provider_name="Netflix", kind="stream",
                                                         monetization="flatrate"), time.time())
            return tid
        year_t = client.portal.call(rok)
        r = client.post(f"/api/titles/{year_t}/refresh")
        assert {x["source"]: x["display"] for x in r.json()["ratings"]}.get("csfd") == "86 %", r.json()["ratings"]
        assert sql(f"SELECT value FROM title_ids WHERE title_id={year_t} AND kind='csfd'") == [("9202",)]

        # the refresh button = that title again from every source: a new picture in the library, an offer that
        # left a service, a library item deleted, a title found on JustWatch by its name
        matrix = sql("SELECT title_id FROM title_ids WHERE kind='imdb' AND value='tt0133093'")[0][0]
        mock_servers.MOVIE["ImageTags"] = {"Primary": "fresh"}
        oneplay = CATALOG[0]["offers"].pop(1)
        r = client.post(f"/api/titles/{matrix}/refresh")
        assert r.status_code == 200 and "fresh" in (r.json()["poster"] or ""), r.json()["poster"]
        provs = {p for (p,) in sql(f"SELECT provider FROM availability WHERE title_id={matrix}")}
        assert "oneplay" not in provs and "netflix" in provs and any(p.startswith("emby-") for p in provs), provs
        assert any(p.startswith("plex-") for p in provs), provs
        CATALOG[0]["offers"].insert(1, oneplay)
        mock_servers.MOVIE["ImageTags"] = {"Primary": "abc"}
        client.post(f"/api/titles/{matrix}/refresh")
        assert ("oneplay",) in sql(f"SELECT provider FROM availability WHERE title_id={matrix}")
        odyssea = sql("SELECT title_id FROM title_ids WHERE kind='imdb' AND value='tt33764258'")[0][0]
        CATALOG.append(jw_node(7, 2026, title="Odyssea", imdb="tt33764258"))
        mock_servers.EMBY_GONE.add("m4")
        r = client.post(f"/api/titles/{odyssea}/refresh")
        assert r.status_code == 200, r.text
        rows = sql(f"SELECT source, provider FROM availability WHERE title_id={odyssea}")
        assert ("justwatch", "netflix") in rows and not any(s_.startswith(("emby:", "jellyfin:")) for s_, _ in rows), rows
        assert sql(f"SELECT value FROM title_ids WHERE title_id={odyssea} AND kind='jw'") == [("tm7",)]
        mock_servers.EMBY_GONE.discard("m4")
        CATALOG.pop()
        r = client.post(f"/api/titles/{odyssea}/refresh")
        rows = sql(f"SELECT source FROM availability WHERE title_id={odyssea}")
        assert any(s_.startswith("emby:") for (s_,) in rows) and ("justwatch",) not in rows, rows

        # TMDB (by tmdb id or found via IMDb id), OMDb (RT + Metacritic), TVmaze (series)
        assert rt["tmdb"] == "7.9" and rt["metacritic"] == "73/100", rt
        stored = json.loads(sql("SELECT value FROM kv WHERE key='settings'")[0][0])
        assert stored["ratings"]["tmdb_api_key"] == "tmdbkey"
        assert client.get("/api/settings").json()["ratings"]["omdb_api_key"] == S.MASK

        # Matrix: the Emby plugin's ČSFD id is kept as the library's (a second copy without it changes nothing)
        mx = sql("SELECT title_id FROM title_ids WHERE kind='imdb' AND value='tt0133093'")[0][0]
        assert sql(f"SELECT value FROM title_ids WHERE title_id={mx} AND kind='csfd_lib'") == [("9499",)]
        # Czech title without ids (Emby) found by search with/without diacritics, ČSFD found by search
        for q in ("pelisky", "Pelíšky"):
            items = client.get("/api/search", params={"q": q}).json()["items"]
            assert items and items[0]["title"] == "Pelíšky", items
        pel = items[0]
        assert {x["source"]: x["display"] for x in pel["ratings"]}.get("csfd") == "89 %", pel["ratings"]
        assert pel["ids"]["csfd"] == "6648"
        # IMDb id linked from the ČSFD page -> IMDb rating in the same run
        assert pel["ids"].get("imdb") == "tt0167331", pel["ids"]
        assert {x["source"]: x["display"] for x in pel["ratings"]}.get("imdb") == "8.2", pel["ratings"]
        assert m["ids"]["imdb"] == "tt0133093"

        # Dune from Plex: DV + Atmos from detail streams
        dune = client.get("/api/search", params={"q": "dune"}).json()["items"][0]
        pd = dune["where"][0]
        print("  Dune ->", pd["quality"], pd["video"], pd["audio"], pd["audio_langs"])
        assert pd["quality"] == "UHD" and "DV" in pd["video"] and "Atmos" in pd["audio"] and pd["audio_langs"] == ["en", "cs"]
        assert dune["poster"].startswith(f"/api/poster/{plex_id}?path=")

        # Series merged across JW / Emby / Plex (imdb + tvdb ids)
        ch = client.get("/api/search", params={"q": "chernobyl"}).json()["items"]
        assert len(ch) == 1, [(c["title"], c["ids"]) for c in ch]
        ch = ch[0]
        print("  Černobyl ->", [(o["provider_name"], o["quality"], o["video"], o["audio"]) for o in ch["where"]])
        e = next(o for o in ch["where"] if o["provider"] == f"emby-{emby_id}")
        assert e["quality"] == "UHD" and "HDR10" in e["video"] and "Atmos" in e["audio"]
        assert {x["source"]: x["display"] for x in ch["ratings"]}["imdb"] == "9.3"
        assert {x["source"]: x["display"] for x in ch["ratings"]}["tvmaze"] == "8.9", ch["ratings"]

        # ---- catalog / providers / poster / api key ----
        cat = client.get("/api/catalog", params={"provider": "oneplay"}).json()
        assert cat["total"] == 1 and cat["items"][0]["title"] in ("Matrix", "The Matrix")
        cat = client.get("/api/catalog", params={"video": "DV", "audio": "Atmos", "lang": "cs", "type": "movie", "page_size": 5}).json()
        assert cat["total"] >= 2500
        cat = client.get("/api/catalog", params={"provider": f"emby-{emby_id}", "sort": "csfd"}).json()
        assert [i["title"] for i in cat["items"]][:2] == ["Matrix", "Pelíšky"], [i["title"] for i in cat["items"]]
        cat = client.get("/api/catalog", params={"q": "matrix"}).json()
        assert cat["total"] == 1 and cat["items"][0]["title"] in ("Matrix", "The Matrix"), cat["total"]
        cat = client.get("/api/catalog", params={"q": "pelisky", "provider": f"emby-{emby_id}"}).json()
        assert [i["title"] for i in cat["items"]] == ["Pelíšky"]
        cat = client.get("/api/catalog", params={"q": "film 100", "sort": "title", "order": "asc", "page_size": 3}).json()
        assert cat["items"][0]["title"] == "Film 1000" and cat["total"] == 10, (cat["total"], [i["title"] for i in cat["items"]])
        # facets: every language present, subtitle filter
        f = client.get("/api/facets").json()
        alang = {x["value"] for x in f["audio_langs"]}
        assert {"cs", "en"} <= alang, alang
        assert {"cs", "en"} <= {x["value"] for x in f["subtitle_langs"]}
        assert "DV" in {x["value"] for x in f["video"]} and "Atmos" in {x["value"] for x in f["audio"]}
        assert {"csfd", "imdb", "tmdb", "tvmaze"} <= {x["value"] for x in f["ratings"]}, f["ratings"]
        assert all(x["value"] not in ("tmdb_api", "omdb") for x in f["ratings"])
        cat = client.get("/api/catalog", params={"lang": "en", "type": "movie", "provider": f"emby-{emby_id}"}).json()
        assert sorted(i["title"] for i in cat["items"]) == ["Matrix", "Odyssea"], [i["title"] for i in cat["items"]]
        cat = client.get("/api/catalog", params={"sub": "en", "provider": f"emby-{emby_id}"}).json()
        assert [i["title"] for i in cat["items"]] == ["Matrix"]
        cat = client.get("/api/catalog", params={"sort": "tvmaze"}).json()
        assert cat["items"][0]["ids"].get("imdb") == "tt7366338"
        # sort by date added on the platform/library; exact quality filter; quality facet
        cat = client.get("/api/catalog", params={"sort": "added", "page_size": 4}).json()
        same = lambda t: "Černobyl" if t == "Chernobyl" else t   # name = first server to create the title (jobs run in parallel)
        # the oldest known date of a title wins (Matrix: Emby 2026, but on a service since 2023)
        assert [same(i["title"]) for i in cat["items"][:3]] == ["Černobyl", "Duna: Část druhá", "Pelíšky"], [(i["title"], [o["added_at"] for o in i["where"]]) for i in cat["items"]]
        cat = client.get("/api/catalog", params={"sort": "added", "provider": f"emby-{emby_id}"}).json()
        assert [same(i["title"]) for i in cat["items"]] == ["Černobyl", "Matrix", "Pelíšky", "Odyssea"], [i["title"] for i in cat["items"]]   # Odyssea: no date
        assert any(o["added_at"] == "2026-11-14T08:00:00" for o in cat["items"][0]["where"])
        assert [x["value"] for x in f["quality"]][:2] == ["UHD", "FHD"] and f["with_added_date"] >= 4, f["quality"]
        cat = client.get("/api/catalog", params={"quality": "FHD", "provider": f"plex-{plex_id}"}).json()
        assert len(cat["items"]) == 2 and {same(i["title"]).replace("The ", "") for i in cat["items"]} == {"Matrix", "Černobyl"}, [i["title"] for i in cat["items"]]
        print("  providers ->", client.get("/api/providers").json()["items"])
        # multi-select filters: values in one filter OR, across filters AND (on the same offer)
        def titles(**prm):
            return sorted(i["title"] for i in client.get("/api/catalog", params={**prm, "page_size": 200}).json()["items"])
        plex_q = titles(provider=f"plex-{plex_id}", quality="UHD,FHD")
        assert plex_q == sorted(titles(provider=f"plex-{plex_id}", quality="UHD") + titles(provider=f"plex-{plex_id}", quality="FHD")), plex_q
        two = titles(provider=f"emby-{emby_id},plex-{plex_id}")
        assert set(two) == set(titles(provider=f"emby-{emby_id}")) | set(titles(provider=f"plex-{plex_id}"))
        assert titles(provider=f"emby-{emby_id}", lang="en,de") == titles(provider=f"emby-{emby_id}", lang="en")
        assert titles(provider=f"emby-{emby_id}", type="movie,show") == titles(provider=f"emby-{emby_id}")
        assert titles(provider=f"emby-{emby_id}", video="DV,HDR10") == sorted(set(titles(provider=f"emby-{emby_id}", video="DV")) | set(titles(provider=f"emby-{emby_id}", video="HDR10")))
        img = client.get(dune["poster"])
        assert img.status_code == 200 or img.status_code == 404  # plex photo transcoder not mocked
        assert client.get(f"/api/poster/{emby_id}", params={"path": "/System/Info"}).status_code == 400
        p = client.get(f"/api/poster/{emby_id}", params={"path": "/Items/m1/Images/Primary?maxHeight=360&tag=abc"})
        assert p.status_code == 200 and p.content.startswith(b"\x89PNG")
        by = client.get("/api/titles/by/imdb/tt0133093").json()
        assert by["id"] == m["id"]

        # ---- per-server save / link mode / delete ----
        from app import links
        assert links.is_lan("10.0.0.20") and links.is_lan("192.168.1.5") and links.is_lan("127.0.0.1") and links.is_lan("fd00::1")
        assert not links.is_lan("8.8.8.8") and not links.is_lan("testclient")
        emby_srv = next(x for x in client.get("/api/settings").json()["servers"] if x["id"] == emby_id)
        assert emby_srv["link_mode"] == "auto" and emby_srv["token"] == S.MASK
        r = client.post("/api/servers", json={**emby_srv, "link_mode": "internal"})
        assert r.status_code == 200 and r.json()["link_mode"] == "internal", r.text
        stored = json.loads(sql("SELECT value FROM kv WHERE key='settings'")[0][0])
        assert next(x for x in stored["servers"] if x["id"] == emby_id)["token"] == "embykey"   # masked token kept
        m = client.get("/api/titles/by/imdb/tt0133093").json()
        em = next(o for o in m["where"] if o["provider"] == f"emby-{emby_id}")
        assert em["url"] == f"{BASE}/emby/web/index.html#!/item?id=m1&serverId=srv123", em["url"]
        auto = {"type": "emby", "url": "http://10.0.0.5:8096", "public_url": "https://emby.example.cz", "link_mode": "auto"}
        assert links.server_link(auto, {"item_id": "m1", "server_id": "s"}, lan=True).startswith("http://10.0.0.5:8096/web/")
        assert links.server_link(auto, {"item_id": "m1", "server_id": "s"}, lan=False).startswith("https://emby.example.cz/web/")
        plex = {"type": "plex", "url": "http://10.0.0.5:32400", "public_url": "", "link_mode": "auto"}
        assert links.server_link(plex, {"rating_key": "1", "machine_id": "mm"}, lan=True).startswith("http://10.0.0.5:32400/web/index.html#!/server/mm/")
        assert links.server_link(plex, {"rating_key": "1", "machine_id": "mm"}, lan=False).startswith("https://app.plex.tv/desktop/#!/server/mm/")
        assert client.post("/api/servers", json={"type": "emby", "name": "x"}).status_code == 400   # url missing
        new = client.post("/api/servers", json={"type": "jellyfin", "name": "Nový", "url": f"{BASE}/emby", "token": "embykey"}).json()
        assert new["id"] and new["token"] == S.MASK
        run_sync(client, f"server:{new['id']}")
        assert sql(f"SELECT COUNT(*) FROM availability WHERE source='jellyfin:{new['id']}'")[0][0] == 4   # 3 films (Matrix copies = one) + series
        assert client.delete(f"/api/servers/{new['id']}").status_code == 200
        assert sql(f"SELECT COUNT(*) FROM availability WHERE source='jellyfin:{new['id']}'")[0][0] == 0
        assert all(x["id"] != new["id"] for x in client.get("/api/settings").json()["servers"])
        assert client.delete(f"/api/servers/{new['id']}").status_code == 404

        # ---- ČSFD anti-bot page: run stops, nothing is stored as "not found" ----
        assert client.put("/api/settings", json={"ratings": {"csfd_daily_budget": 0}}).status_code == 200
        mock_servers.CSFD_STATE["blocked"] = True
        sql_exec = lambda q: (lambda con: (con.execute(q), con.commit(), con.close()))(sqlite3.connect(DB_PATH))
        sql_exec("DELETE FROM ratings WHERE source='csfd'")
        before = sql("SELECT COUNT(*) FROM title_ids WHERE kind='csfd'")[0][0]
        st = run_sync(client, "ratings")
        last = next(j["last"] for j in st["jobs"] if j["id"] == "ratings")
        assert last["status"] == "partial" and "anti-bot" in last["message"], last
        assert sql("SELECT COUNT(*) FROM ratings WHERE source='csfd'")[0][0] == 0
        assert sql("SELECT COUNT(*) FROM title_ids WHERE kind='csfd'")[0][0] == before
        mock_servers.CSFD_STATE["blocked"] = False
        st = run_sync(client, "ratings")
        assert sql("SELECT COUNT(*) FROM ratings WHERE source='csfd' AND value IS NOT NULL")[0][0] >= 2

        # existing install from before ČSFD became opt-in keeps it on
        cur = json.loads(sql("SELECT value FROM kv WHERE key='settings'")[0][0])
        cur["ratings"].pop("csfd", None)
        sql_exec("UPDATE kv SET value='" + json.dumps(cur).replace("'", "''") + "' WHERE key='settings'")
        sql_exec("DELETE FROM kv WHERE key='migrate.csfd_optin_v3'")
        assert client.get("/api/settings").json()["ratings"]["csfd"] is True
        sql_exec("UPDATE kv SET value='" + json.dumps(cur).replace("'", "''") + "' WHERE key='settings'")
        assert client.get("/api/settings").json()["ratings"]["csfd"] is False   # migration runs once
        # old default ČSFD cap (400) is migrated to "no limit"
        cur = json.loads(sql("SELECT value FROM kv WHERE key='settings'")[0][0])
        cur["ratings"]["csfd_daily_budget"] = 400
        sql_exec("UPDATE kv SET value='" + json.dumps(cur).replace("'", "''") + "' WHERE key='settings'")
        assert client.get("/api/settings").json()["ratings"]["csfd_daily_budget"] == 0

        client.post("/api/auth/logout")
        client.cookies.clear()
        assert client.get("/api/settings").status_code == 401
        assert client.get("/api/stats").status_code == 401
        assert client.get("/api/settings", headers={"X-Api-Key": token}).status_code == 200
        assert client.get("/api/settings", headers={"X-Api-Key": "nope"}).status_code == 401
        assert client.post("/api/auth/login", json={"password": "spatne"}).status_code == 401
        r = client.post("/api/auth/login", json={"password": "heslo1234"}).json()
        assert r["role"] == "admin" and r["session"]
        admin = r["session"]

        # the connection password: the catalogue only; the admin password connects too
        assert client.post("/api/auth/viewer", json={"password": "kratke"}).status_code == 400
        assert client.post("/api/auth/viewer", json={"password": "divame123"}).json() == {"set": True}
        assert client.put("/api/settings", json={"public_url": "https://ml.example.cz"}).status_code == 200
        client.post("/api/auth/logout"); client.cookies.clear()
        st = client.get("/api/auth/state").json()
        assert st["role"] is None and st["public_url"] == "https://ml.example.cz"
        v = client.post("/api/auth/login", json={"password": "divame123"}).json()
        assert v["role"] == "viewer"
        client.cookies.clear()
        bearer = {"Authorization": f"Bearer {v['session']}"}
        assert client.get("/api/catalog", headers=bearer).status_code == 200
        assert client.get(f"/api/stats?s={v['session']}").status_code == 200          # images: the session in the URL
        assert client.get("/api/settings", headers=bearer).status_code == 403
        assert client.post("/api/sync", headers=bearer).status_code == 403
        assert client.get("/api/auth/state", headers=bearer).json()["role"] == "viewer"
        assert client.get("/api/settings", headers={"Authorization": f"Bearer {admin}"}).status_code == 200
        # logos for the web's evening-out: only the logo hosts, never an arbitrary address
        for bad in ("http://169.254.169.254/x", "https://example.com/x.png", "http://images.justwatch.com/x.png"):
            assert client.get("/api/logo", params={"url": bad}, headers={"Authorization": f"Bearer {admin}"}).status_code == 400, bad
        # a new connection password ends the sessions of the old one; removing it too
        assert client.post("/api/auth/viewer", json={"password": "jinedivame1"}, headers={"Authorization": f"Bearer {admin}"}).status_code == 200
        assert client.get("/api/catalog", headers=bearer).status_code == 401
        assert client.post("/api/auth/viewer", json={"password": None}, headers={"Authorization": f"Bearer {admin}"}).json() == {"set": False}
        assert client.post("/api/auth/login", json={"password": "jinedivame1"}).status_code == 401
        assert client.post("/api/auth/login", json={"password": "heslo1234"}).status_code == 200

        # ---- iVysílání: picked like a service, its own job, titles paired by name + year ----
        from app.sources import ivysilani
        ivysilani.API = f"{BASE}/ct/graphql/"
        provs = client.get("/api/settings").json()["justwatch"]["providers"]
        jw_runs = sql("SELECT COUNT(*) FROM sync_runs WHERE source='justwatch'")[0][0]
        assert client.put("/api/settings", json={"justwatch": {"providers": [*provs, "ivy"]}}).status_code == 200
        run_sync(client, "ivysilani")
        assert sql("SELECT COUNT(*) FROM sync_runs WHERE source='justwatch'")[0][0] == jw_runs   # JustWatch not restarted
        assert mock_servers.CT_CALLS[0]["referer"] == "https://www.ceskatelevize.cz/"
        matrix = client.get("/api/titles/by/imdb/tt0133093").json()
        ivy = [o for o in matrix["where"] if o["provider"] == "ivysilani"]
        assert ivy and ivy[0]["url"] == "https://www.ceskatelevize.cz/porady/10123-matrix/" and ivy[0]["monetization"] == "free", matrix["where"]
        assert sql("SELECT t.year FROM titles t JOIN title_ids i ON i.title_id=t.id WHERE i.kind='ct' AND i.value='20001'")[0][0] == 1977
        assert sql("SELECT COUNT(*) FROM availability WHERE provider='ivysilani'")[0][0] == 3
        assert client.put("/api/settings", json={"justwatch": {"providers": provs}}).status_code == 200

        # ---- languages in other forms are merged into one code ----
        from app.quality import lang, langs
        assert [lang(x) for x in ("cs", "cze", "ces", "cs-CZ", "Czech", "Čeština", "Czech (Forced)")] == ["cs"] * 7
        assert langs(["eng", "English", "en-US", "und", "nob", "nb", "Brazilian Portuguese"]) == ["en", "no", "pt"]
        # "original" and audio description are no languages; a short word of a phrase is no language code
        assert langs(["qaa", "qad", "org", "Original", "to be added", "as original", "pt BR", "English SDH"]) == ["pt", "en"]

        # ---- stale removal: drop a title from the JW catalogue, re-sync ----
        CATALOG.pop()  # Černobyl gone from Netflix
        run_sync(client, "justwatch")
        ch = client.get("/api/search", params={"q": "chernobyl"}).json()["items"][0]
        assert "netflix" not in {o["provider"] for o in ch["where"]}
        m2 = client.get("/api/titles/by/imdb/tt0133093").json()
        r2 = {x["source"]: x["display"] for x in m2["ratings"]}
        assert r2["imdb"] == "8.7" and r2["tmdb"] == "7.9" and r2["rottentomatoes"] == "88 %", r2  # JW re-sync overwrites nothing
        print("  stats ->", client.get("/api/stats").json())
    print("ALL TESTS PASSED")


main()
