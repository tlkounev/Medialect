// State of one running synchronisation job (port of SyncContext).
import { now } from "./db";
import type { Settings } from "./settings";

export class SyncContext {
  started = now();
  items = 0;
  notes: string[] = [];
  partial = false;
  phase = "";
  constructor(public source: string, public settings: Settings) {}
  progress(phase: string) { this.phase = phase; }
  note(msg: string) { console.info(`[${this.source}] ${msg}`); this.notes.push(msg); }
}
