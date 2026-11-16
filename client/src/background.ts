// Android: while a synchronisation runs, a foreground service with a progress notification keeps the
// app alive when the user leaves it (screen off, another app). It does not start syncs on its own.
import { invoke } from "@tauri-apps/api/core";
import { env } from "./core/env";
import { manager } from "./core/sync";

interface State { active: boolean; text: string; percent: number }

async function describe(): Promise<State> {
  const jobs = [...manager.running.values()];
  const t = (window as any).t;
  let names = new Map<string, string>();
  if (jobs.some((c) => c.source.startsWith("server:"))) {
    try { names = new Map((await manager.jobs()).map(([id, label]) => [id, label])); } catch { /* keep ids */ }
  }
  const label = (id: string) => (id === "ratings" ? (t?.("job.ratings") || "Hodnocení")
    : id === "justwatch" ? (t?.("job.catalog") || "Katalog") : names.get(id) || id);
  const known = jobs.map((c) => c.percent).filter((p): p is number => p != null);
  return {
    active: jobs.length > 0,
    text: jobs.map((c) => `${label(c.source)}${c.percent != null ? ` ${c.percent} %` : ""}`).join(" · "),
    percent: known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : -1,
  };
}

// One call at a time, always ending on the latest state. (Reporting "started" and "finished" as two
// independent calls could leave the service running for good when a job ended before the first call returned.)
let sent: State = { active: false, text: "", percent: -1 };
let busy = false, again = false, lastAt = 0, failedAt = 0;

async function pump(): Promise<void> {
  if (busy) { again = true; return; }
  busy = true;
  try {
    do {
      again = false;
      const want = await describe();
      if (!want.active && !sent.active) continue;
      if (want.active && !sent.active && Date.now() - failedAt < 30000) continue;   // Android refused: do not hammer
      // start and stop at once; progress updates at most every 2 s
      if (want.active && sent.active && (want.text === sent.text || Date.now() - lastAt < 2000)) continue;
      try {
        await invoke("plugin:apk-updater|background", { active: want.active, title: "Medialect", text: want.text, percent: want.percent });
        sent = want;
        lastAt = Date.now();
      } catch (e) {
        console.warn("background service", e);
        sent = { ...want, active: false };   // not running (e.g. started while the app was in the background)
        failedAt = Date.now();
      }
    } while (again);
  } finally { busy = false; }
}

export function initBackground(): void {
  if (!/Android/i.test(navigator.userAgent) || !(window as any).__TAURI_INTERNALS__) return;
  env.onActivity = () => { pump(); };
  // timers of a hidden WebView are throttled (up to once a minute); native pauses are not
  env.sleep = (ms: number) => invoke("plugin:apk-updater|sleep", { ms }) as Promise<void>;
}
