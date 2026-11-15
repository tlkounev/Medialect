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

async function openExternal(url: string): Promise<void> {
  if ((window as any).__TAURI_INTERNALS__) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);            // Android hands streaming links to the installed app (Netflix, Disney+, ...)
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
  installFetchShim();
  document.addEventListener("click", (e) => {
    const a = (e.target as Element)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || !/^https?:/.test(a.href) || new URL(a.href).origin === location.origin) return;
    e.preventDefault();
    openExternal(a.href).catch(console.error);
  });
  await loadScript("/static/i18n.js");
  await loadScript("/static/app.js");
  manager.start();
}

start().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML("afterbegin", `<pre class="err" style="padding:16px">Medialect: ${String(e?.message || e)}</pre>`);
});
