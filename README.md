# Medialect

Vlastní backend, který zjistí, kde je který film nebo seriál ke shlédnutí: ve tvých knihovnách
(Emby, Jellyfin, Plex) i na streamovacích službách (Netflix, Disney+, HBO Max, SkyShowtime,
Oneplay…). U každého místa ukáže kvalitu obrazu a zvuku, jazyky, odkaz „Pustit“ a hodnocení
(ČSFD, IMDb, Rotten Tomatoes, TMDB, volitelně Metacritic, Letterboxd a Trakt přes MDBList).

## Spuštění

Image se sestavuje automaticky přes GitHub Actions do `ghcr.io/tlkounev/medialect`
(`latest` = poslední verze v `main`, verze podle tagů `v*`, platformy amd64 a arm64).

### QNAP Container Station
Create → **Create Application** → název `medialect` → vlož obsah `docker-compose.yml` → Create.
Pak otevři `http://<NAS>:8890` a nastav heslo.

Aktualizace: v Container Station u aplikace zvol znovunasazení s novým stažením image
(nebo `docker compose pull && docker compose up -d`).

### Docker CLI
```bash
docker compose up -d
```

Data (SQLite, nastavení) jsou v pojmenovaném svazku `medialect-data` (`/data` v kontejneru).
Port se mění proměnnou `PORT`. Vlastní build ze zdrojáků: `docker build -t medialect .`

## Nastavení (vše ve webovém rozhraní)

| Sekce | Co vyplnit |
|---|---|
| Mediální servery | Typ, interní URL, volitelně veřejnou URL (z ní se staví odkazy „Pustit“), klíč |
| JustWatch | Zaškrtni služby, kde máš účet. Bez klíče. |
| Streaming Availability | Volitelné: API klíč z movieofthenight.com (přímo nebo přes RapidAPI), katalogy, denní limit |
| Hodnocení | IMDb dataset, ČSFD, volitelně klíč MDBList |

**Kde vzít klíče**
- **Emby:** Nastavení → Pokročilé → API klíče → Nový.
- **Jellyfin:** Ovládací panel → API klíče.
- **Plex:** `X-Plex-Token` – otevři v Plex Web libovolnou položku → ⋯ → *Získat informace* →
  *Zobrazit XML*, token je v URL za `X-Plex-Token=`.

## Jak to funguje

- **Knihovny** se čtou přes jejich API. Kvalita se bere z jednotlivých streamů (rozlišení, DV/HDR10/HDR10+/HLG,
  Atmos/DTS:X/TrueHD/DD+, jazyky zvuku a titulků). U seriálů se agreguje přes epizody.
  ID z ČSFD pluginu v Emby (ProviderIds obsahující „csfd“) se převezme, takže ČSFD hodnocení
  se pak stahuje bez hledání.
- **JustWatch** (neoficiální GraphQL přes `simple-justwatch-python-api`): celý katalog vybraných
  služeb. API vrací max. 1999 titulů na dotaz, proto se katalog prochází po rocích vydání
  a okno, které narazí na limit, se rozpůlí.
- **Streaming Availability** (volitelné): přesnější deep linky (např. `netflix.com/watch/…`).
  Když stejnou nabídku zná i JustWatch, sloučí se a použije se jeho odkaz. Procházení katalogu
  se dá přerušit a pokračuje další den, takže se vejde i do malého denního limitu.
- **Párování titulů** napříč zdroji: IMDb → TMDB → TVDB → název + rok (±1) bez konfliktu ID.
- **Hodnocení:** IMDb z oficiálního datasetu (`datasets.imdbws.com`, jednou denně), ČSFD scrapingem
  (stránka nemá API; limit titulů za den, pauza 1,5 s), MDBList s limitem 1000 dotazů denně
  na free tarifu, skóre z JustWatch.
- Synchronizace běží automaticky podle intervalu, ručně ji spustíš na záložce **Stav**.

## API

Autorizace: cookie z přihlášení, nebo hlavička `X-Api-Key` (klíč najdeš v Nastavení).

| Endpoint | Popis |
|---|---|
| `GET /api/search?q=matrix&type=movie` | Hledání (s i bez diakritiky, české i originální názvy) |
| `GET /api/catalog?provider=netflix&min_quality=UHD&video=DV&audio=Atmos&lang=cs&sort=csfd` | Seznam s filtry a řazením |
| `GET /api/titles/{id}` | Detail titulu |
| `GET /api/titles/by/imdb/tt0133093` | Titul podle externího ID (`imdb`, `tmdb_movie`, `tmdb_tv`, `tvdb`, `csfd`) |
| `GET /api/providers` | Služby a knihovny s počtem titulů |
| `POST /api/sync[?job=justwatch]` | Spuštění synchronizace |
| `GET /api/sync/status` | Stav posledních běhů a denních limitů |

Každá nabídka v `where[]` obsahuje `provider`, `quality` (`SD/HD/FHD/QHD/UHD`), `video`, `audio`,
`audio_langs`, `subtitle_langs`, `url` a u knihoven `extra.item_id` / `extra.rating_key` pro další integrace.

## Co ještě není ověřené proti živým službám

Testy (`python tests/run_tests.py`) běží proti falešným serverům. Proti skutečným službám zatím neproběhly tyhle části:
- přesné HTML ČSFD (regulární výrazy pro hledání a hodnocení),
- endpoint MDBList (`api.mdblist.com/imdb/{movie|show}/{id}`, při 404 starší `mdblist.com/api/?i=`),
- jak moc JustWatch u českých nabídek vyplňuje `videoTechnology` / `audioTechnology`.
