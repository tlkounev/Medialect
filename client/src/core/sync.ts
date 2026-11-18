// Runs synchronisations, records their status, schedules periodic runs (port of app/sync.py).
import { env, SourceError } from "./env";
import { now } from "./db";
import { SyncContext } from "./context";
import * as settingsMod from "./settings";
import * as justwatch from "./justwatch";
import * as ivysilani from "./ivysilani";
import * as ratings from "./ratings";
import * as store from "./store";
import { jwProviders } from "./queries";
import { serverSync } from "./servers";

type JobFn = (ctx: SyncContext) => Promise<void>;

export class SyncManager {
  running = new Map<string, SyncContext>();
  queued = new Set<string>();
  private ratingsAgain = false;
  private fullRunning = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  async jobs(): Promise<[string, string, JobFn][]> {
    const s = await settingsMod.load();
    const out: [string, string, JobFn][] = [];
    for (const srv of s.servers || []) {
      if (srv.enabled !== false && srv.url) out.push([`server:${srv.id}`, srv.name || srv.type, serverSync(srv)]);
    }
    if (s.justwatch.enabled && jwProviders(s.justwatch.providers).length > 0) out.push(["justwatch", "JustWatch", justwatch.sync]);
    if (ivysilani.selected(s)) out.push(["ivysilani", "iVysílání", ivysilani.sync]);
    out.push(["ratings", "Hodnocení", ratings.sync]);
    return out;
  }

  async runJob(id: string, fn: JobFn): Promise<void> {
    if (this.running.has(id)) return;
    const ctx = new SyncContext(id, await settingsMod.load());
    this.running.set(id, ctx);
    this.queued.delete(id);
    env.onActivity();
    const runId = (await env.db.run("INSERT INTO sync_runs(source, started_at, status) VALUES(?,?,?)", [id, ctx.started, "running"])).lastId;
    let status = "ok", message: string | null = null;
    try {
      await fn(ctx);
      status = ctx.partial ? "partial" : "ok";
      message = ctx.notes.slice(-20).join("\n") || null;
    } catch (e) {
      status = "error";
      message = e instanceof SourceError ? e.message : `${(e as Error)?.name || "Error"}: ${(e as Error)?.message || e}`;
      if (!(e instanceof SourceError)) console.error(e);
    } finally {
      this.running.delete(id);
      env.onActivity();
      await env.db.run("UPDATE sync_runs SET finished_at=?, status=?, message=?, items=? WHERE id=?",
        [now(), status, message, ctx.items, runId]);
    }
    // new titles need ratings: run (or re-run) the ratings job after every source sync
    if (id === "ratings") {
      if (this.ratingsAgain) { this.ratingsAgain = false; this.trigger("ratings"); }
    } else if (status !== "error" && !this.fullRunning) {
      if (this.running.has("ratings")) this.ratingsAgain = true; else this.trigger("ratings");
    }
  }

  async run(only?: string | null): Promise<void> {
    if (only) {
      for (const [id, , fn] of await this.jobs()) if (id === only) await this.runJob(id, fn);
      return;
    }
    if (this.fullRunning) return;
    this.fullRunning = true;
    try {
      const fixed = await store.repairMixedTitles();
      if (fixed) console.info(`repair: ${fixed} titles mixing two works dropped, the full sync recreates them`);
      const jobs = await this.jobs();
      for (const [id] of jobs) if (!this.running.has(id)) this.queued.add(id);
      // the sources (own servers, JustWatch, iVysílání) download at the same time; ratings follow
      await Promise.all(jobs.filter(([id]) => id !== "ratings" && !this.running.has(id)).map(([id, , fn]) => this.runJob(id, fn)));
      for (const [id, , fn] of jobs) if (id === "ratings" && !this.running.has(id)) await this.runJob(id, fn);
      if (jobs.some(([id]) => id !== "ratings")) await env.db.kvSet("sync.last_full", now());
    } finally {
      this.queued.clear();
      this.fullRunning = false;
    }
  }

  /** Start servers that have never been synchronised (e.g. just added in the settings). */
  async triggerNewServers(): Promise<void> {
    for (const [id] of await this.jobs()) {
      if (id.startsWith("server:") && !this.running.has(id)
          && !(await env.db.get("SELECT 1 AS x FROM sync_runs WHERE source=? LIMIT 1", [id]))) this.trigger(id);
    }
  }

  trigger(only?: string | null): void {
    this.run(only).catch((e) => console.error("sync", e));
  }

  async status() {
    const out: { id: string; label: string; running: boolean; queued: boolean; progress: { phase: string; items: number; started_at: number; percent: number | null } | null; last: unknown }[] = [];
    for (const [id, label] of await this.jobs()) {
      const row = await env.db.get("SELECT * FROM sync_runs WHERE source=? ORDER BY started_at DESC LIMIT 1", [id]);
      const ctx = this.running.get(id);
      out.push({ id, label, running: !!ctx, queued: this.queued.has(id),
        progress: ctx ? { phase: ctx.phase, items: ctx.items, started_at: ctx.started, percent: ctx.percent } : null, last: row || null });
    }
    return out;
  }

  /** An interrupted JustWatch run is continued on its own 10 minutes after it stopped. */
  private async jwUnfinished(s: settingsMod.Settings): Promise<boolean> {
    if (this.fullRunning || this.running.has("justwatch") || !s.justwatch.enabled || !jwProviders(s.justwatch.providers).length) return false;
    if (!(await justwatch.resumePending())) return false;
    const row = await env.db.get("SELECT finished_at FROM sync_runs WHERE source='justwatch' ORDER BY started_at DESC LIMIT 1");
    return !!row?.finished_at && now() - row.finished_at >= 600;
  }

  /** While the app is open: run a full sync when the interval has passed (checked every minute). */
  start(): void {
    const tick = async () => {
      try {
        const s = await settingsMod.load();
        const last = await env.db.kvGet<number>("sync.last_full", 0);
        if (now() - last >= Math.max(1, Number(s.sync_interval_hours)) * 3600 && !this.fullRunning) await this.run();
        else if (await this.jwUnfinished(s)) this.trigger("justwatch");
      } catch (e) { console.error("scheduler", e); }
    };
    setTimeout(tick, 3000);
    this.timer = setInterval(tick, 60000);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }
}

export const manager = new SyncManager();
