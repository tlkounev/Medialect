// Updates from GitHub releases: the app announces a new version, the user decides whether to install it.
// Windows + Linux AppImage: Tauri updater (signed latest.json in the release), then restart.
// Android (phone, tablet, Google TV): the apk-updater plugin downloads the APK and installs it.
import { handle } from "./core/api";
import { env } from "./core/env";

const CHECK_EVERY_MS = 6 * 3600 * 1000;
let busy = false;
const tried = new Set<string>();      // versions already offered in this run (do not nag after "Later")

const tr = (key: string, vars: Record<string, unknown>, fallback: string) => {
  const t = (window as any).t;
  return typeof t === "function" ? t(key, vars) : fallback;
};

/** Bottom bar "New version X is available [Update] [Later]"; resolves true when the user wants it. */
function offer(version: string): Promise<boolean> {
  return new Promise((resolve) => {
    document.querySelector(".update-bar")?.remove();
    const bar = document.createElement("div");
    bar.className = "update-bar";
    bar.setAttribute("role", "dialog");
    const text = document.createElement("span");
    text.textContent = tr("app.updateAvailable", { v: version }, `New version ${version} is available.`);
    const yes = document.createElement("button");
    yes.textContent = tr("app.updateNow", {}, "Update");
    const no = document.createElement("button");
    no.className = "ghost";
    no.textContent = tr("app.later", {}, "Later");
    yes.onclick = () => { bar.remove(); resolve(true); };
    no.onclick = () => { bar.remove(); resolve(false); };
    bar.append(text, yes, no);
    document.body.appendChild(bar);
  });
}

function say(key: string, vars: Record<string, unknown>, fallback: string, toast: (t: string) => void): void {
  const t = (window as any).t;
  toast(typeof t === "function" ? t(key, vars) : fallback);
}

async function android(toast: (t: string) => void): Promise<void> {
  const st: any = await handle("GET", "/api/version", new URLSearchParams("refresh=1"), undefined);
  if (st.state !== "update" || !st.latest || tried.has(st.latest)) return;
  tried.add(st.latest);
  if (!(await offer(st.latest))) return;
  const url = `https://github.com/${env.repo}/releases/download/app-v${st.latest}/Medialect_${st.latest}_android.apk`;
  say("app.updating", { v: st.latest }, `Updating to ${st.latest}…`, toast);
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("plugin:apk-updater|install", { url });
  } catch (e) {
    say("app.updateFailed", { e: String(e) }, `Update failed: ${e}`, toast);
  }
}

async function desktop(toast: (t: string) => void): Promise<void> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check({ timeout: 30000 });
  if (!update || tried.has(update.version)) return;
  tried.add(update.version);
  if (!(await offer(update.version))) return;
  say("app.updating", { v: update.version }, `Updating to ${update.version}…`, toast);
  try {
    await update.downloadAndInstall();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    // e.g. installed from .deb/.rpm: those are updated by the package manager, the version badge shows the new release
    console.warn("update", e);
  }
}

export function startAutoUpdates(toast: (t: string) => void): void {
  if (!(window as any).__TAURI_INTERNALS__) return;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      if (/Android/i.test(navigator.userAgent)) await android(toast);
      else await desktop(toast);
    } catch (e) {
      console.warn("update check", e);
    } finally { busy = false; }
  };
  setTimeout(run, 15000);
  setInterval(run, CHECK_EVERY_MS);
}
