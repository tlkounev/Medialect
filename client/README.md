# Medialect – aplikace (Android, Windows, Linux)

Samostatná aplikace bez serveru: katalog, synchronizace i hodnocení běží přímo v zařízení.
Rozhraní je stejné jako u Docker verze (`app/static`), místo serveru odpovídá lokální `/api` (`src/core`).

- `src/core` – JustWatch, databáze (SQLite), filtry, hodnocení (IMDb, TMDB, TVmaze, OMDb, MDBList, ČSFD volitelně)
- `src-tauri` – Tauri 2 (SQLite, HTTP bez CORS, otevírání odkazů v aplikacích)
- `npm test` – testy jádra s podvrženými službami; `LIVE=1 npx vitest run test/live.test.ts` proti skutečným službám

Instalační soubory staví GitHub Actions (`.github/workflows/app.yml`) a vydává je jako release `app-v0.1.x`.
