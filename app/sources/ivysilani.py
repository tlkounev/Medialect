"""iVysílání (Česká televize): its free films and series, read from the GraphQL API its own web uses.

The API is not documented; the query is the one open-source tools use (sunecz/Media-Downloader,
tompta1/ivysilani-rated). It gives the ČT id, slug, Czech title and year, no IMDb/ČSFD ids, so titles
are paired with the rest of the catalogue by name + year (store.upsert_title)."""

from __future__ import annotations

import asyncio
import re
import time

from .. import store
from ..db import db
from .base import SourceError, SyncContext, http_client

SHORT_NAME = "ivy"                 # how the service appears in the user's service list (settings)
PROVIDER = "ivysilani"             # provider key of its offers in the catalogue
NAME = "iVysílání"
ICON = "https://icons.duckduckgo.com/ip3/www.ceskatelevize.cz.ico"
COUNTRIES = ("CZ",)
API = "https://api.ceskatelevize.cz/graphql/"
WEB = "https://www.ceskatelevize.cz/porady/"
CATEGORIES = (("3947", "movie", "filmy"), ("3976", "show", "seriály"))
PAGE = 40                          # the API answers 400 above 40
DELAY_S = 0.4

# The API is not documented: the richer variants ask for a picture in the field names ČT's own pages use;
# when the API rejects one, the next (and finally the bare list without pictures) is used.
_LIST = """query GetCategoryById($limit: PaginationAmount!, $offset: Int!, $categoryId: String!,
  $order: OrderByDirection, $orderBy: CategoryOrderByType) {
  showFindByGenre(limit: $limit, offset: $offset, categoryId: $categoryId, order: $order, orderBy: $orderBy) {
    items { id slug title year %s __typename }
    totalCount
  }
}"""
QUERIES = [_LIST % "images { card(width: 480) }", _LIST % "imageUrl(width: 480, height: 270)", _LIST % ""]

def provider_info() -> dict:
    """The entry added to the country's service list, so it is picked and ordered like the others."""
    return {"short_name": SHORT_NAME, "name": NAME, "technical_name": PROVIDER, "icon": ICON, "monetization_types": ["FREE"]}


async def register(country: str, items: list[dict]) -> list[dict]:
    if country.upper() not in COUNTRIES:
        return items
    keys = await db.kv_get("jw.provider_keys", {})
    keys[SHORT_NAME] = PROVIDER
    await db.kv_set("jw.provider_keys", keys)
    icons = await db.kv_get("jw.provider_icons", {})
    icons[PROVIDER] = ICON
    await db.kv_set("jw.provider_icons", icons)
    return sorted([*items, provider_info()], key=lambda p: p["name"].lower())


def selected(settings: dict) -> bool:
    return (settings.get("country", "").upper() in COUNTRIES
            and SHORT_NAME in (settings.get("justwatch", {}).get("providers") or []))


def year_of(value) -> int | None:
    m = re.search(r"(1[89]|20)\d\d", str(value or ""))
    return int(m.group(0)) if m else None


def picture(it: dict) -> str | None:
    url = (it.get("images") or {}).get("card") if isinstance(it.get("images"), dict) else None
    url = url or it.get("imageUrl")
    if not url:
        return None
    return "https:" + url if url.startswith("//") else url


async def _page(client, category: str, offset: int, variant: list[int]) -> tuple[list[dict], int]:
    last = None
    attempt = 0
    while attempt < 4:
        body = {"operationName": "GetCategoryById", "query": QUERIES[variant[0]],
                "variables": {"categoryId": category, "limit": PAGE, "offset": offset, "order": "asc", "orderBy": "alphabet"}}
        try:
            r = await client.post(API, json=body)
            data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
            found = (data.get("data") or {}).get("showFindByGenre")
            if found is not None:
                return found.get("items") or [], int(found.get("totalCount") or 0)
            if data.get("errors") and variant[0] < len(QUERIES) - 1:
                variant[0] += 1                     # a field the API does not know: ask without it
                continue
            if data.get("errors"):
                raise SourceError(f"iVysílání: neočekávaná odpověď {str(data.get('errors'))[:200]}")
            last = f"HTTP {r.status_code}"
        except SourceError:
            raise
        except Exception as e:  # noqa: BLE001 - network hiccup: try again
            last = f"{type(e).__name__}: {e}"
        attempt += 1
        await asyncio.sleep(3 * attempt)
    raise SourceError(f"iVysílání nedostupné: {last}")


async def sync(ctx: SyncContext) -> None:
    started = time.time()
    variant = [await db.kv_get("ivysilani.query", 0)]
    async with http_client(headers={"Referer": "https://www.ceskatelevize.cz/", "Origin": "https://www.ceskatelevize.cz"}) as client:
        for i, (category, ttype, label) in enumerate(CATEGORIES):
            ctx.step(i, len(CATEGORIES))
            offset, total = 0, None
            while total is None or offset < total:
                ctx.progress(f"iVysílání – {label}", offset / total if total else 0)
                items, total = await _page(client, category, offset, variant)
                if not items:
                    break
                for it in items:
                    if not it.get("id") or not it.get("title"):
                        continue
                    tid = await store.upsert_title(store.TitleInfo(
                        type=ttype, title=it["title"].strip(), year=year_of(it.get("year")), poster=picture(it),
                        ids={"ct": str(it["id"])}))
                    slug = it.get("slug") or str(it["id"])
                    await store.upsert_offer(tid, store.Offer(
                        source=PROVIDER, provider=PROVIDER, provider_name=NAME, kind="stream", monetization="free",
                        url=f"{WEB}{slug}/", audio_langs=["cs"]), started)
                    ctx.items += 1
                offset += PAGE
                await asyncio.sleep(DELAY_S)
    await db.kv_set("ivysilani.query", variant[0])
    removed = await store.remove_stale(PROVIDER, started)
    ctx.note(f"iVysílání: {ctx.items} pořadů" + (f", {removed} už nedostupných odebráno" if removed else ""))
