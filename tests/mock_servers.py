"""Fake Emby / Jellyfin / Plex / Streaming Availability / IMDb / ČSFD endpoints for offline tests."""

import gzip

from fastapi import FastAPI, Header, Request, Response

app = FastAPI()
EMBY_TOKEN = "embykey"
PLEX_TOKEN = "plextoken"


def _emby_ok(token, auth):
    return token == EMBY_TOKEN or (auth or "").endswith(f'"{EMBY_TOKEN}"')


# ---------------- Emby / Jellyfin ----------------
CT_SHOWS = {
    "3947": [{"id": "10123", "slug": "10123-matrix", "title": "Matrix", "year": "1999"},
             {"id": "10124", "slug": "10124-vrchni-prchni", "title": "Vrchní, prchni!", "year": "1980"}],
    "3976": [{"id": "20001", "slug": "20001-nemocnice", "title": "Nemocnice na kraji města", "year": "1977–1981"}],
}
CT_CALLS: list[dict] = []


@app.post("/ct/graphql/")
async def ct_graphql(request: Request):
    body = await request.json()
    CT_CALLS.append({"vars": body["variables"], "referer": request.headers.get("referer")})
    v = body["variables"]
    items = CT_SHOWS.get(v["categoryId"], [])
    return {"data": {"showFindByGenre": {"items": items[v["offset"]:v["offset"] + v["limit"]], "totalCount": len(items)}}}


@app.get("/emby/System/Info")
async def emby_info(x_emby_token: str | None = Header(None), authorization: str | None = Header(None)):
    if not _emby_ok(x_emby_token, authorization):
        return Response(status_code=401)
    return {"Id": "srv123", "ServerName": "Emby doma", "Version": "4.9.1"}


@app.get("/emby/Users")
async def emby_users():
    return [{"Id": "u1", "Name": "user", "Policy": {"IsAdministrator": False}},
            {"Id": "u2", "Name": "admin", "Policy": {"IsAdministrator": True}}]


MOVIE = {
    "Id": "m1", "Name": "Matrix", "OriginalTitle": "The Matrix", "ProductionYear": 1999,
    "ProviderIds": {"Imdb": "tt0133093", "Tmdb": "603", "Csfd": "9499-matrix"},
    "DateCreated": "2026-11-10T20:00:00.0000000Z",
    "ImageTags": {"Primary": "abc"},
    "MediaSources": [{"MediaStreams": [
        {"Type": "Video", "Width": 3840, "Height": 1608, "Codec": "hevc", "VideoRange": "HDR",
         "ExtendedVideoType": "DolbyVision", "DisplayTitle": "4K HEVC Dolby Vision"},
        {"Type": "Audio", "Codec": "truehd", "Profile": "Dolby TrueHD + Dolby Atmos", "Channels": 8, "Language": "eng",
         "DisplayTitle": "English TrueHD Atmos 7.1"},
        {"Type": "Audio", "Codec": "ac3", "Channels": 6, "Language": "cze", "DisplayTitle": "Czech Dolby Digital 5.1"},
        {"Type": "Subtitle", "Language": "cze"}, {"Type": "Subtitle", "Language": "eng"},
    ]}],
}
NOIDS = {"Id": "m2", "Name": "Pelíšky", "ProductionYear": 1999, "ProviderIds": {}, "DateCreated": "2025-01-02T10:00:00.0000000Z",
         "MediaSources": [{"MediaStreams": [{"Type": "Video", "Width": 1920, "Height": 1080, "Codec": "h264"},
                                            {"Type": "Audio", "Codec": "aac", "Channels": 2, "Language": "ces"}]}]}
# two rips in one folder = one item with two versions; the listing returns only the default one
VERSIONS = {"Id": "m4", "Name": "Odyssea", "ProductionYear": 2026, "ProviderIds": {"Imdb": "tt33764258"},
            "MediaSourceCount": 2,
            "MediaSources": [{"MediaStreams": [{"Type": "Video", "Width": 3840, "Height": 2160, "Codec": "hevc"},
                                               {"Type": "Audio", "Codec": "dts", "Channels": 6, "Language": "eng"}]}]}
VERSIONS_FULL = {**VERSIONS, "MediaSources": VERSIONS["MediaSources"] + [{"MediaStreams": [
    {"Type": "Video", "Width": 3840, "Height": 2160, "Codec": "hevc"},
    {"Type": "Audio", "Codec": "eac3", "Channels": 6, "Language": "cze"}]}]}

# a second, worse copy of Matrix with a German track added later: the catalogue shows the tracks of both
MOVIE_COPY = {"Id": "m3", "Name": "Matrix", "ProductionYear": 1999, "ProviderIds": {"Imdb": "tt0133093"},
              "DateCreated": "2024-01-01T20:00:00.0000000Z",
              "MediaSources": [{"MediaStreams": [{"Type": "Video", "Width": 1920, "Height": 800, "Codec": "h264"},
                                                 {"Type": "Audio", "Codec": "ac3", "Channels": 6, "Language": "ger"}]}]}
SERIES = {"Id": "s1", "Name": "Černobyl", "OriginalTitle": "Chernobyl", "ProductionYear": 2019,
          "ProviderIds": {"Imdb": "tt7366338", "Tvdb": "360893"}}
EPISODES = [
    {"Id": "e1", "SeriesId": "s1", "MediaSources": [{"MediaStreams": [
        {"Type": "Video", "Width": 1920, "Height": 1080, "Codec": "h264"},
        {"Type": "Audio", "Codec": "eac3", "Channels": 6, "Language": "eng"}]}]},
    {"Id": "e2", "SeriesId": "s1", "DateCreated": "2026-11-14T08:00:00.0000000Z", "MediaSources": [{"MediaStreams": [
        {"Type": "Video", "Width": 3840, "Height": 2160, "Codec": "hevc", "VideoRangeType": "HDR10"},
        {"Type": "Audio", "Codec": "eac3", "Channels": 6, "Language": "cze", "Profile": "Dolby Atmos"}]}]},
]


EMBY_GONE: set[str] = set()       # items deleted from the library (tests of the refresh button)


@app.get("/emby/Users/{uid}/Items/{item_id}")
async def emby_item(uid: str, item_id: str):
    found = {"m1": MOVIE, "m2": NOIDS, "m3": MOVIE_COPY, "m4": VERSIONS_FULL, "s1": {**SERIES, "Type": "Series"}}.get(item_id)
    if not found or item_id in EMBY_GONE:
        return Response(status_code=404)
    return found


@app.get("/emby/Users/{uid}/Items")
async def emby_items(uid: str, IncludeItemTypes: str, StartIndex: int = 0, Limit: int = 100,
                     SearchTerm: str | None = None, ParentId: str | None = None):
    assert uid == "u2", "must use admin user"
    data = {"Movie": [MOVIE, NOIDS, MOVIE_COPY, VERSIONS], "Series": [SERIES], "Episode": EPISODES}[IncludeItemTypes]
    data = [d for d in data if d["Id"] not in EMBY_GONE]
    if SearchTerm:
        data = [d for d in data if SearchTerm.lower() in (d["Name"] + " " + d.get("OriginalTitle", "")).lower()]
    if ParentId:
        data = [d for d in data if d.get("SeriesId") == ParentId]
    return {"Items": data[StartIndex:StartIndex + Limit], "TotalRecordCount": len(data)}


@app.get("/emby/Items/{iid}/Images/Primary")
async def emby_img(iid: str, x_emby_token: str | None = Header(None)):
    if x_emby_token != EMBY_TOKEN:
        return Response(status_code=401)
    return Response(b"\x89PNGfake", media_type="image/png")


# ---------------- Plex ----------------
def _plex_ok(req: Request):
    return req.headers.get("x-plex-token") == PLEX_TOKEN


@app.get("/plex/identity")
async def plex_identity():
    return {"MediaContainer": {"machineIdentifier": "plexmachine", "version": "1.41"}}


@app.get("/plex/library/sections")
async def plex_sections(request: Request):
    if not _plex_ok(request):
        return Response(status_code=401)
    return {"MediaContainer": {"Directory": [{"key": "1", "type": "movie"}, {"key": "2", "type": "show"}]}}


PLEX_MOVIE = {"ratingKey": "101", "title": "Duna: Část druhá", "originalTitle": "Dune: Part Two", "year": 2024,
              "thumb": "/library/metadata/101/thumb/1", "addedAt": 1763000000,
              "Guid": [{"id": "imdb://tt15239678"}, {"id": "tmdb://693134"}],
              "Media": [{"videoResolution": "4k", "videoCodec": "hevc", "audioCodec": "truehd", "audioChannels": 8}]}
PLEX_MATRIX = {"ratingKey": "102", "title": "The Matrix", "year": 1999, "Guid": [{"id": "imdb://tt0133093"}],
               "Media": [{"videoResolution": "1080", "videoCodec": "h264", "audioCodec": "dca", "audioChannels": 6}]}
PLEX_SHOW = {"ratingKey": "201", "title": "Chernobyl", "year": 2019, "Guid": [{"id": "tvdb://360893"}]}
PLEX_EPS = [{"ratingKey": "301", "grandparentRatingKey": "201", "Media": [{"videoResolution": "1080", "videoCodec": "h264"}]}]


@app.get("/plex/library/sections/{key}/all")
async def plex_all(key: str, request: Request):
    start = int(request.query_params.get("X-Plex-Container-Start", 0))
    if key == "1":
        items = [PLEX_MOVIE, PLEX_MATRIX]
    elif request.query_params.get("type") == "4":
        items = PLEX_EPS
    else:
        items = [PLEX_SHOW]
    page = items[start:start + 300]
    return {"MediaContainer": {"size": len(page), "totalSize": len(items), "Metadata": page}}


@app.get("/plex/library/metadata/{rk}")
async def plex_meta(rk: str):
    if rk == "101":
        m = dict(PLEX_MOVIE)
        m["Media"] = [{**PLEX_MOVIE["Media"][0], "Part": [{"Stream": [
            {"streamType": 1, "codec": "hevc", "DOVIPresent": True, "displayTitle": "4K DoVi/HDR10 (HEVC Main 10)"},
            {"streamType": 2, "codec": "truehd", "channels": 8, "displayTitle": "English (TRUEHD 7.1)",
             "extendedDisplayTitle": "English (Dolby TrueHD Atmos 7.1)", "languageCode": "eng"},
            {"streamType": 2, "codec": "eac3", "channels": 6, "languageCode": "ces"},
            {"streamType": 3, "languageCode": "ces"}]}]}]
        return {"MediaContainer": {"Metadata": [m]}}
    if rk == "301":
        return {"MediaContainer": {"Metadata": [{**PLEX_EPS[0], "Media": [{"videoResolution": "1080", "Part": [{"Stream": [
            {"streamType": 2, "codec": "eac3", "channels": 6, "languageCode": "ces"}]}]}]}]}}
    base = {"102": PLEX_MATRIX, "201": PLEX_SHOW}.get(rk, {"ratingKey": rk, "Media": [{"videoResolution": "1080"}]})
    return {"MediaContainer": {"Metadata": [base]}}


@app.get("/plex/library/metadata/{rk}/allLeaves")
async def plex_leaves(rk: str):
    return {"MediaContainer": {"Metadata": [e for e in PLEX_EPS if e["grandparentRatingKey"] == rk]}}


@app.get("/plex/hubs/search")
async def plex_search(query: str):
    found = [m for m in (PLEX_MOVIE, PLEX_MATRIX, PLEX_SHOW)
             if query.lower() in (m["title"] + " " + m.get("originalTitle", "")).lower()]
    return {"MediaContainer": {"Hub": [{"type": "mixed", "Metadata": [
        {**m, "type": "show" if m is PLEX_SHOW else "movie"} for m in found]}]}}


# ---------------- Streaming Availability ----------------
SA_PAGES = [
    {"shows": [{"itemType": "show", "showType": "movie", "id": "1", "imdbId": "tt0133093", "tmdbId": "movie/603",
                "title": "The Matrix", "originalTitle": "The Matrix", "releaseYear": 1999,
                "streamingOptions": {"cz": [{"service": {"id": "netflix", "name": "Netflix"}, "type": "subscription",
                                             "link": "https://www.netflix.com/watch/20557937", "quality": "uhd",
                                             "audios": [{"language": "ces"}, {"language": "eng"}],
                                             "subtitles": [{"closedCaptions": False, "locale": {"language": "ces"}}],
                                             "expiresSoon": False, "availableSince": 1700000000}]}}],
     "hasMore": True, "nextCursor": "c2"},
    {"shows": [{"itemType": "show", "showType": "movie", "id": "2", "imdbId": "tt9999999", "tmdbId": "movie/1",
                "title": "Other", "releaseYear": 2020,
                "streamingOptions": {"cz": [{"service": {"id": "netflix", "name": "Netflix"}, "type": "subscription",
                                             "link": "https://www.netflix.com/title/1", "quality": "hd",
                                             "audios": [], "subtitles": [], "expiresSoon": False, "availableSince": 1}]}}],
     "hasMore": False},
]
SA_CALLS = []


@app.get("/sa/shows/search/filters")
async def sa_filters(request: Request):
    assert request.headers.get("x-api-key") == "sakey"
    SA_CALLS.append(dict(request.query_params))
    if request.query_params.get("show_type") == "series":
        return {"shows": [], "hasMore": False}
    return SA_PAGES[1] if request.query_params.get("cursor") == "c2" else SA_PAGES[0]


# ---------------- IMDb dataset ----------------
@app.get("/imdb/title.ratings.tsv.gz")
async def imdb():
    tsv = "tconst\taverageRating\tnumVotes\ntt0133093\t8.7\t2100000\ntt7366338\t9.3\t900000\ntt0000001\t5.0\t10\ntt0167331\t8.2\t50000\n"
    return Response(gzip.compress(tsv.encode()), media_type="application/gzip")


# ---------------- ČSFD ----------------
CSFD_SEARCH = """<section class="main-movies"><div class="box-content">
<article class="article article-poster-50"><figure></figure><div class="article-content">
<header class="article-header"><h3 class="film-title-nooverflow">
<a href="/film/6648-pelisky/" class="film-title-name">Pelíšky</a> <span class="film-title-info"><span class="info">(1999)</span></span>
</h3></header></div></article>
<article class="article article-poster-50"><div class="article-content"><h3>
<a href="/film/123-pelisky-2/" class="film-title-name">Pelíšky 2</a><span class="info">(2025)</span></h3></div></article>
</div></section>"""
CSFD_FILM = """<div class="film-header"><h1>Pelíšky</h1></div>
<div class="rating-average-withtabs"><div class="film-rating-average">  89%  </div></div>
IMDBLINK
<section class="box ratings-list"><header><h3>Hodnocení <span class="counter">(97 852)</span></h3></header></section>"""
# a revival listed under the original series: "Scrubs" (2026) = series 10 of "Scrubs: Doktůrci (2001–2026)"
CSFD_SEARCH_SCRUBS = """<section class="main-movies"><div class="box-content">
<article class="article"><h3><a href="/film/777-scrubs-dokturci/" class="film-title-name">Scrubs: Doktůrci</a>
<span class="info">(2001)</span> <span class="info">(seriál)</span></h3></article></div></section>"""
CSFD_SEARCH_TWINS = """<section class="main-movies"><div class="box-content">
<article class="article"><h3><a href="/film/8001-dvojnik/" class="film-title-name">Dvojník</a> <span class="info">(2026)</span></h3></article>
<article class="article"><h3><a href="/film/8002-dvojnik/" class="film-title-name">Dvojník</a> <span class="info">(2026)</span></h3></article>
</div></section>"""
CSFD_SERIES = """<div class="film-header"><h1>Scrubs: Doktůrci</h1>
<div class="origin">USA<span>, </span>(2001–2026)<span>, </span>182 h</div></div>
<div class="film-rating-average">81%</div>"""
ANUBIS = """<html><body><script id="anubis_challenge" type="application/json">{"rules":{"algorithm":"fast"}}</script></body></html>"""
CSFD_STATE = {"blocked": False}


@app.get("/csfd/hledat/")
async def csfd_search(q: str, request: Request):
    if CSFD_STATE["blocked"] or "Mozilla" in request.headers.get("user-agent", ""):
        return Response(ANUBIS, media_type="text/html")
    if q.startswith("Scrubs"):
        return Response(CSFD_SEARCH_SCRUBS, media_type="text/html")
    if q.startswith("Dvojn"):
        return Response(CSFD_SEARCH_TWINS, media_type="text/html")
    if q == "Rok":
        return Response(CSFD_SEARCH_TWINS.split("<article")[0] + "<article" + CSFD_SEARCH_TWINS.split("<article")[2]
                        .replace("8002", "9202").replace("Dvojník", "Rok"), media_type="text/html")
    if q.startswith("Trojice"):
        return Response(CSFD_SEARCH_TWINS.replace("8001", "9101").replace("8002", "9102").replace("Dvojník", "Trojice"), media_type="text/html")
    return Response(CSFD_SEARCH, media_type="text/html")


@app.get("/csfd/film/{fid}/prehled/")
async def csfd_film(fid: str, request: Request):
    if CSFD_STATE["blocked"] or "Mozilla" in request.headers.get("user-agent", ""):
        return Response(ANUBIS, media_type="text/html")
    if fid == "777":
        return Response(CSFD_SERIES, media_type="text/html")
    if fid in ("9101", "9102"):       # a page without any IMDb link loses to the one with the title's IMDb id
        link = '<a href="https://www.imdb.com/title/tt9100002/" class="button-imdb">IMDb</a>' if fid == "9102" else ""
        return Response(CSFD_FILM.replace("IMDBLINK", link).replace("89%", "12%" if fid == "9101" else "64%"), media_type="text/html")
    if fid in ("9201", "9202"):       # one name, other years: the year on the page tells them apart
        page = CSFD_FILM.replace("IMDBLINK", f'<div class="origin">USA<span>, </span>{"1999" if fid == "9201" else "2026"}, 120 min</div>')
        return Response(page.replace("89%", "21%" if fid == "9201" else "86%"), media_type="text/html")
    if fid in ("8001", "8002"):       # two films of one name and year: the IMDb link tells them apart
        imdb = "tt8000001" if fid == "8001" else "tt8000002"
        page = CSFD_FILM.replace("IMDBLINK", f'<a href="https://www.imdb.com/title/{imdb}/" class="button-imdb">IMDb</a>')
        return Response(page.replace("89%", "33%" if fid == "8001" else "77%"), media_type="text/html")
    page = CSFD_FILM.replace("IMDBLINK", '<a href="https://www.imdb.com/title/tt0167331/" class="button-imdb">IMDb</a>'
                             if fid == "6648" else "")
    return Response(page.replace("89%", "91%") if fid == "9499" else page, media_type="text/html")


# ---------------- TMDB / TVmaze / OMDb ----------------
@app.get("/tmdb/find/{imdb}")
async def tmdb_find(imdb: str, api_key: str = ""):
    if api_key != "tmdbkey":
        return Response(status_code=401)
    return {"movie_results": [{"id": 4242}] if imdb == "tt0167331" else [], "tv_results": []}


@app.get("/tmdb/{kind}/{tid}")
async def tmdb_item(kind: str, tid: str, api_key: str = ""):
    if api_key != "tmdbkey":
        return Response(status_code=401)
    return {"id": int(tid), "vote_average": 7.9 if tid == "603" else 7.1, "vote_count": 1234}


@app.get("/tvmaze/lookup/shows")
async def tvmaze_lookup(imdb: str | None = None, thetvdb: str | None = None):
    if imdb == "tt7366338" or thetvdb == "360893":
        return {"id": 1, "url": "https://www.tvmaze.com/shows/1/chernobyl", "rating": {"average": 8.9}}
    return Response(status_code=404)


@app.get("/omdb/")
async def omdb(apikey: str, i: str):
    if apikey != "omdbkey":
        return Response(status_code=401)
    return {"Response": "True", "imdbID": i, "Ratings": [
        {"Source": "Internet Movie Database", "Value": "8.7/10"},
        {"Source": "Rotten Tomatoes", "Value": "88%"},
        {"Source": "Metacritic", "Value": "73/100"}]}


# registered last: /sa/shows/search/filters must match first
@app.get("/sa/shows/{kind}/{value}")
@app.get("/sa/shows/{value}")
async def sa_show(value: str, request: Request, kind: str | None = None):
    assert request.headers.get("x-api-key") == "sakey"
    show = next((s for page in SA_PAGES for s in page["shows"]
                 if value in (s["imdbId"], s["tmdbId"].split("/")[-1])), None)
    return show if show else Response(status_code=404)
