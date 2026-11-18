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

QUERY = """query GetCategoryById($limit: PaginationAmount!, $offset: Int!, $categoryId: String!,
  $order: OrderByDirection, $orderBy: CategoryOrderByType) {
  showFindByGenre(limit: $limit, offset: $offset, categoryId: $categoryId, order: $order, orderBy: $orderBy) {
    items { id slug title year __typename }
    totalCount
  }
}"""


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


async def _page(client, category: str, offset: int) -> tuple[list[dict], int]:
    body = {"operationName": "GetCategoryById", "query": QUERY,
            "variables": {"categoryId": category, "limit": PAGE, "offset": offset, "order": "asc", "orderBy": "alphabet"}}
    last = None
    for attempt in range(4):
        try:
            r = await client.post(API, json=body)
            if r.status_code == 200:
                data = r.json()
                found = (data.get("data") or {}).get("showFindByGenre")
                if found is None:
                    raise SourceError(f"iVysílání: neočekávaná odpověď {str(data.get('errors'))[:200]}")
                return found.get("items") or [], int(found.get("totalCount") or 0)
            last = f"HTTP {r.status_code}"
        except SourceError:
            raise
        except Exception as e:  # noqa: BLE001 - network hiccup: try again
            last = f"{type(e).__name__}: {e}"
        await asyncio.sleep(3 * (attempt + 1))
    raise SourceError(f"iVysílání nedostupné: {last}")


async def sync(ctx: SyncContext) -> None:
    started = time.time()
    async with http_client(headers={"Referer": "https://www.ceskatelevize.cz/", "Origin": "https://www.ceskatelevize.cz"}) as client:
        for i, (category, ttype, label) in enumerate(CATEGORIES):
            ctx.step(i, len(CATEGORIES))
            offset, total = 0, None
            while total is None or offset < total:
                ctx.progress(f"iVysílání – {label}", offset / total if total else 0)
                items, total = await _page(client, category, offset)
                if not items:
                    break
                for it in items:
                    if not it.get("id") or not it.get("title"):
                        continue
                    tid = await store.upsert_title(store.TitleInfo(
                        type=ttype, title=it["title"].strip(), year=year_of(it.get("year")), ids={"ct": str(it["id"])}))
                    slug = it.get("slug") or str(it["id"])
                    await store.upsert_offer(tid, store.Offer(
                        source=PROVIDER, provider=PROVIDER, provider_name=NAME, kind="stream", monetization="free",
                        url=f"{WEB}{slug}/", audio_langs=["cs"]), started)
                    ctx.items += 1
                offset += PAGE
                await asyncio.sleep(DELAY_S)
    removed = await store.remove_stale(PROVIDER, started)
    ctx.note(f"iVysílání: {ctx.items} pořadů" + (f", {removed} už nedostupných odebráno" if removed else ""))
