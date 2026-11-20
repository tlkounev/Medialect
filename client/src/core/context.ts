// State of one running synchronisation job (port of SyncContext).
import { now } from "./db";
import { env } from "./env";
import type { Settings } from "./settings";

export class SyncContext {
  started = now();
  items = 0;
  notes: string[] = [];
  partial = false;
  phase = "";
  percent: number | null = null;
  /** The refresh button: the per-title rating sources rate only this title. */
  only: number | null = null;
  private span: [number, number] = [0, 1];
  constructor(public source: string, public settings: Settings) {}
  /** The job runs n consecutive steps; fractions reported from now on belong to step i (0-based). */
  step(i: number, n: number) { this.span = [i / n, (i + 1) / n]; this.percent = Math.floor(this.span[0] * 100); }
  /** fraction (0–1) = estimated share of the job already done; undefined keeps the last value. */
  progress(phase: string, fraction?: number) {
    this.phase = phase;
    env.onActivity();
    if (fraction !== undefined) {
      const [lo, hi] = this.span;
      this.percent = Math.max(0, Math.min(99, Math.floor((lo + fraction * (hi - lo)) * 100)));
    }
  }
  note(msg: string) { console.info(`[${this.source}] ${msg}`); this.notes.push(msg); }
}
