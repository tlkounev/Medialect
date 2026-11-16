// Runs synchronisations, records their status, schedules periodic runs (port of app/sync.py).
import { env, SourceError } from "./env";
import { now } from "./db";
import { SyncContext } from "./context";
import * as settingsMod from "./settings";
import * as justwatch from "./justwatch";
import * as ratings from "./ratings";
import * as store from "./store";

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
    if (s.justwatch.enabled && s.justwatch.providers.length) out.push(["justwatch", "JustWatch", justwatch.sync]);
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
      for (const [id, , fn] of jobs) if (!this.running.has(id)) await this.runJob(id, fn);
      if (jobs.some(([id]) => id !== "ratings")) await env.db.kvSet("sync.last_full", now());
    } finally {
      this.queued.clear();
      this.fullRunning = false;
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

  /** While the app is open: run a full sync when the interval has passed (checked every minute). */
  start(): void {
    const tick = async () => {
      try {
        const s = await settingsMod.load();
        const last = await env.db.kvGet<number>("sync.last_full", 0);
        if (now() - last >= Math.max(1, Number(s.sync_interval_hours)) * 3600 && !this.fullRunning) await this.run();
      } catch (e) { console.error("scheduler", e); }
    };
    setTimeout(tick, 3000);
    this.timer = setInterval(tick, 60000);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }
}

export const manager = new SyncManager();
