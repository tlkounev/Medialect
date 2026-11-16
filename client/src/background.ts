// Android: while a synchronisation runs, a foreground service with a progress notification keeps the
// app alive when the user leaves it (screen off, another app). It does not start syncs on its own.
import { invoke } from "@tauri-apps/api/core";
import { env } from "./core/env";
import { manager } from "./core/sync";

let active = false, last = 0, lastText = "";

function describe(): { text: string; percent: number | null } {
  const jobs = [...manager.running.values()];
  const t = (window as any).t;
  const label = (id: string) => (id === "ratings" ? (t?.("job.ratings") || "Hodnocení") : id === "justwatch" ? (t?.("job.catalog") || "Katalog") : id);
  const parts = jobs.map((c) => `${label(c.source)}${c.percent != null ? ` ${c.percent} %` : ""}`);
  const known = jobs.map((c) => c.percent).filter((p): p is number => p != null);
  return { text: parts.join(" · "), percent: known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : null };
}

async function report(): Promise<void> {
  const running = manager.running.size > 0;
  if (!running && !active) return;
  const t = Date.now();
  const { text, percent } = describe();
  // stop at once; otherwise at most one update every 2 s
  if (running && active && (t - last < 2000 || text === lastText)) return;
  last = t; lastText = text;
  try {
    await invoke("plugin:apk-updater|background", { active: running, title: "Medialect", text, percent: percent ?? -1 });
    active = running;
  } catch (e) { console.warn("background service", e); }
}

export function initBackground(): void {
  if (!/Android/i.test(navigator.userAgent) || !(window as any).__TAURI_INTERNALS__) return;
  env.onActivity = () => { report(); };
  // timers of a hidden WebView are throttled (up to once a minute); native pauses are not
  env.sleep = (ms: number) => invoke("plugin:apk-updater|sleep", { ms }) as Promise<void>;
}
