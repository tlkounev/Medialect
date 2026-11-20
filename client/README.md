# Medialect – the Android app

The app for phones, tablets, Google TV and Android TV. It works in two ways:

- **On its own** – the catalogue, synchronisation and ratings run right on the device.
- **With a Medialect server** – it shows the catalogue of your server (Docker) and downloads nothing.

The interface is the same as the server's (`app/static`); instead of the server, a local `/api` answers
(`src/core`, the server's logic in TypeScript).

- `src/core` – JustWatch, iVysílání, Emby / Jellyfin / Plex, the database (SQLite), filters, ratings
  (IMDb, TMDB, TVmaze, OMDb, MDBList, ČSFD)
- `src-tauri` – Tauri 2 (SQLite, HTTP without CORS, opening links in the services' apps, the TV launcher)
- `src/tv.ts` – remote-control navigation for Google TV / Android TV
- `npm test` – tests of the core against fake services; `LIVE=1 npx vitest run test/live.test.ts`
  against the real ones

GitHub Actions (`.github/workflows/app.yml`) builds the APK on every merge to `main` and publishes it as
release `app-v0.1.x`. The newest one is always at
[releases/latest/download/Medialect-android.apk](https://github.com/tlkounev/Medialect/releases/latest/download/Medialect-android.apk).
