// App entry: local database + HTTP, the /api shim, then the same UI the Docker server serves.
import { Db, serialized } from "./core/db";
import { env } from "./core/env";
import { installFetchShim } from "./core/api";
import { manager } from "./core/sync";

declare const __APP_VERSION__: string;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Cannot load ${src}`));
    document.body.appendChild(s);
  });
}

function toast(text: string): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

async function openExternal(url: string): Promise<void> {
  if ((window as any).__TAURI_INTERNALS__) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    try {
      await openUrl(url);          // Android hands streaming links to the installed app (Netflix, Disney+, ...)
    } catch (e) {
      // e.g. a TV without a browser and without the service's app
      const t = (window as any).t;
      toast(typeof t === "function" ? t("app.noHandler") : "No app can open this link.");
      console.error(e);
    }
  } else {
    window.open(url, "_blank", "noopener");
  }
}

async function start(): Promise<void> {
  env.version = __APP_VERSION__;
  (window as any).MEDIALECT_LOCAL = true;
  if ((window as any).__TAURI_INTERNALS__) {
    const { sqlDriver, httpFetch } = await import("./platform/tauri");
    env.db = new Db(serialized(await sqlDriver()));
    env.fetch = httpFetch;
  } else {
    // plain browser (development preview): in-memory demo database, real fetch
    const { browserDriver } = await import("./platform/browser");
    env.db = new Db(serialized(await browserDriver()));
  }
  await env.db.open();
  // the app was closed or killed during a synchronisation: that run is over (JustWatch continues where it stopped)
  await env.db.run("UPDATE sync_runs SET status='error', message=?, finished_at=? WHERE status='running'",
    ["Přerušeno zavřením aplikace", Date.now() / 1000]);
  installFetchShim();
  if ((window as any).__TAURI_INTERNALS__) {
    const { logo } = await import("./logo");
    (window as any).MEDIALECT_LOGO = logo;     // logos of the same size in the catalogue
  }
  (await import("./background")).initBackground();   // before anything can start a sync
  document.addEventListener("click", (e) => {
    const a = (e.target as Element)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || !/^https?:/.test(a.href) || new URL(a.href).origin === location.origin) return;
    e.preventDefault();
    openExternal(a.href).catch(console.error);
  });
  await loadScript("/static/i18n.js");
  await loadScript("/static/app.js");
  manager.start();
  const { startAutoUpdates } = await import("./updates");
  startAutoUpdates(toast);
  const { isTv, enableTvNavigation } = await import("./tv");
  if (isTv()) enableTvNavigation();
}

start().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML("afterbegin", `<pre class="err" style="padding:16px">Medialect: ${String(e?.message || e)}</pre>`);
});
