// Updates from GitHub releases: the app announces a new version, the user decides whether to install it.
// A declined version is not offered again automatically; Settings → App updates can install it any time.
// Windows + Linux AppImage: Tauri updater (signed latest.json in the release), then restart.
// Android (phone, tablet, Google TV): the APK is downloaded in the browser and installed by the system.
// The app itself never installs packages (no REQUEST_INSTALL_PACKAGES: Play Protect flags such apps).
import { handle } from "./core/api";
import { env } from "./core/env";

const CHECK_EVERY_MS = 6 * 3600 * 1000;
const DECLINED_KEY = "medialect.update.declined";
const isAndroid = () => /Android/i.test(navigator.userAgent);

interface Update { version: string; android?: boolean; install: () => Promise<void> }

let toast: (t: string) => void = () => {};
let found: Update | null = null;
let checking = false;

const tr = (key: string, vars: Record<string, unknown>, fallback: string) => {
  const t = (window as any).t;
  return typeof t === "function" ? t(key, vars) : fallback;
};
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const declined = () => { try { return localStorage.getItem(DECLINED_KEY); } catch { return null; } };
const decline = (v: string) => { try { localStorage.setItem(DECLINED_KEY, v); } catch { /* ignore */ } };

async function find(): Promise<Update | null> {
  if (isAndroid()) {
    const st: any = await handle("GET", "/api/version", new URLSearchParams("refresh=1"), undefined);
    if (st.error) throw new Error(st.error);
    if (st.state !== "update" || !st.latest) return null;
    const version = String(st.latest);
    const url = `https://github.com/${env.repo}/releases/download/app-v${version}/Medialect_${version}_android.apk`;
    return { version, android: true, install: async () => {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } };
  }
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check({ timeout: 30000 });
  if (!update) return null;
  return { version: update.version, install: async () => {
    await update.downloadAndInstall();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } };
}

async function install(): Promise<void> {
  if (!found) return;
  $("#updateBar")?.classList.add("hidden");
  toast(found.android
    ? tr("app.download", { v: found.version }, `Downloading ${found.version} in the browser – open the file when it finishes to install it.`)
    : tr("app.updating", { v: found.version }, `Updating to ${found.version}…`));
  try {
    await found.install();
  } catch (e) {
    // desktop .deb/.rpm installs are updated by the package manager
    toast(tr("app.updateFailed", { e: String(e) }, `Update failed: ${e}`));
  }
}

/** Settings → App updates: current state and the install button. */
function renderSettings(error = false): void {
  const state = $("#updState"), btn = $("#updInstall");
  if (!state || !btn) return;
  if (found) {
    state.textContent = tr("app.updateAvailable", { v: found.version }, `New version ${found.version} is available.`);
    btn.textContent = `${tr("app.updateNow", {}, "Update")} → ${found.version}`;
  } else {
    state.textContent = error ? tr("upd.unknown", {}, "Could not check for a new version.")
      : tr("upd.current", { v: env.version }, `You are on the latest version ${env.version}.`);
  }
  btn.classList.toggle("hidden", !found);
}

async function run(manual: boolean): Promise<void> {
  if (checking) return;
  checking = true;
  let error = false;
  try {
    found = await find();
  } catch (e) {
    console.warn("update check", e);
    error = true;
  } finally { checking = false; }
  renderSettings(error);
  const bar = $("#updateBar");
  if (found && bar && (manual || declined() !== found.version)) {
    bar.querySelector("span")!.textContent =
      tr("app.updateAvailable", { v: found.version }, `New version ${found.version} is available.`);
    bar.classList.remove("hidden");
  }
}

export function startAutoUpdates(showToast: (t: string) => void): void {
  if (!(window as any).__TAURI_INTERNALS__) return;
  toast = showToast;
  $("#updateNow")?.addEventListener("click", () => { install(); });
  $("#updateLater")?.addEventListener("click", () => {
    if (found) decline(found.version);
    $("#updateBar")?.classList.add("hidden");
  });
  $("#updInstall")?.addEventListener("click", () => { install(); });
  $("#updCheck")?.addEventListener("click", () => { run(true); });
  renderSettings();
  setTimeout(() => run(false), 15000);
  setInterval(() => run(false), CHECK_EVERY_MS);
}
