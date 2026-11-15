"""Fake Emby / Jellyfin / Plex / Streaming Availability / IMDb / ČSFD endpoints for offline tests."""

import gzip

from fastapi import FastAPI, Header, Request, Response

app = FastAPI()
EMBY_TOKEN = "embykey"
PLEX_TOKEN = "plextoken"


def _emby_ok(token, auth):
    return token == EMBY_TOKEN or (auth or "").endswith(f'"{EMBY_TOKEN}"')


# ---------------- Emby / Jellyfin ----------------
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


@app.get("/emby/Users/{uid}/Items")
async def emby_items(uid: str, IncludeItemTypes: str, StartIndex: int = 0, Limit: int = 100):
    assert uid == "u2", "must use admin user"
    data = {"Movie": [MOVIE, NOIDS], "Series": [SERIES], "Episode": EPISODES}[IncludeItemTypes]
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
    return {"MediaContainer": {"Metadata": [{"ratingKey": rk, "Media": [{"videoResolution": "1080"}]}]}}


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
ANUBIS = """<html><body><script id="anubis_challenge" type="application/json">{"rules":{"algorithm":"fast"}}</script></body></html>"""
CSFD_STATE = {"blocked": False}


@app.get("/csfd/hledat/")
async def csfd_search(q: str, request: Request):
    if CSFD_STATE["blocked"] or "Mozilla" in request.headers.get("user-agent", ""):
        return Response(ANUBIS, media_type="text/html")
    return Response(CSFD_SEARCH, media_type="text/html")


@app.get("/csfd/film/{fid}/prehled/")
async def csfd_film(fid: str, request: Request):
    if CSFD_STATE["blocked"] or "Mozilla" in request.headers.get("user-agent", ""):
        return Response(ANUBIS, media_type="text/html")
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
