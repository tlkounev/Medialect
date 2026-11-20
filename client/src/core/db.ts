// SQLite storage behind a tiny driver interface: the app uses tauri-plugin-sql, tests use node:sqlite.

import { langs } from "./quality";

export type Param = string | number | null;
export type Row = Record<string, any>;

export interface Driver {
  run(sql: string, params: Param[]): Promise<{ changes: number; lastId: number }>;
  all(sql: string, params: Param[]): Promise<Row[]>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS titles (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, original_title TEXT, year INTEGER,
  poster TEXT, created_at REAL, updated_at REAL);
CREATE TABLE IF NOT EXISTS title_ids (
  kind TEXT NOT NULL, value TEXT NOT NULL, title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  PRIMARY KEY (kind, value));
CREATE INDEX IF NOT EXISTS ix_title_ids_tid ON title_ids(title_id);
CREATE TABLE IF NOT EXISTS title_names (
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE, norm TEXT NOT NULL, PRIMARY KEY (title_id, norm));
CREATE INDEX IF NOT EXISTS ix_title_names_norm ON title_names(norm);
CREATE TABLE IF NOT EXISTS availability (
  id INTEGER PRIMARY KEY, title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  source TEXT NOT NULL, provider TEXT NOT NULL, provider_name TEXT, kind TEXT NOT NULL, monetization TEXT NOT NULL,
  quality TEXT, video TEXT, audio TEXT, audio_langs TEXT, subtitle_langs TEXT, url TEXT, extra TEXT,
  expires_on TEXT, added_at TEXT, seen_at REAL NOT NULL,
  UNIQUE (title_id, source, provider, monetization));
CREATE INDEX IF NOT EXISTS ix_av_provider ON availability(provider);
CREATE INDEX IF NOT EXISTS ix_av_source ON availability(source, seen_at);
CREATE TABLE IF NOT EXISTS ratings (
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE, source TEXT NOT NULL, value REAL,
  display TEXT, votes INTEGER, url TEXT, updated_at REAL NOT NULL, PRIMARY KEY (title_id, source));
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, started_at REAL NOT NULL, finished_at REAL, status TEXT NOT NULL,
  message TEXT, items INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_sync_runs_source ON sync_runs(source, started_at);
`;

const clean = (params: unknown[]): Param[] =>
  params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : (p as Param)));

export const now = () => Date.now() / 1000;
const today = () => new Date().toISOString().slice(0, 10);

export class Db {
  constructor(private d: Driver) {}

  async open(): Promise<void> {
    for (const pragma of ["PRAGMA journal_mode=WAL", "PRAGMA foreign_keys=ON"]) {
      try { await this.d.all(pragma, []); } catch { /* not every driver returns rows for pragmas */ }
    }
    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await this.d.run(stmt, []);
    // services stored under JustWatch's spelling of their name
    await this.d.run("UPDATE availability SET provider_name='Prima+' WHERE lower(trim(provider_name))='prima plus'", []);
    await this.normaliseLangs();
  }

  /** One language = one code in the filters: older rows may hold "cze", "Czech", "nb" next to "cs", "no". */
  private async normaliseLangs(): Promise<void> {
    if ((await this.kvGet<number>("migrate.langs", 0)) >= 4) return;
    const rows = await this.all("SELECT rowid AS rid, audio_langs, subtitle_langs FROM availability WHERE audio_langs IS NOT NULL OR subtitle_langs IS NOT NULL");
    const parse = (v: unknown): string[] => { try { return v ? JSON.parse(String(v)) : []; } catch { return []; } };
    for (const r of rows) {
      await this.run("UPDATE availability SET audio_langs=?, subtitle_langs=? WHERE rowid=?",
        [JSON.stringify(langs(parse(r.audio_langs))), JSON.stringify(langs(parse(r.subtitle_langs))), r.rid]);
    }
    await this.kvSet("migrate.langs", 4);
  }

  run(sql: string, params: unknown[] = []) { return this.d.run(sql, clean(params)); }
  all(sql: string, params: unknown[] = []) { return this.d.all(sql, clean(params)); }
  async get(sql: string, params: unknown[] = []): Promise<Row | undefined> { return (await this.all(sql, params))[0]; }

  async kvGet<T = any>(key: string, def: T = null as T): Promise<T> {
    const r = await this.get("SELECT value FROM kv WHERE key=?", [key]);
    return r ? JSON.parse(r.value) : def;
  }
  async kvSet(key: string, value: unknown): Promise<void> {
    await this.run("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [key, JSON.stringify(value)]);
  }

  /** Consume one request from a per-day budget. False when exhausted; limit <= 0 = unlimited. */
  async budgetTake(name: string, limit: number): Promise<boolean> {
    if (limit <= 0) return true;
    const key = `budget:${name}:${today()}`;
    const used = await this.kvGet<number>(key, 0);
    if (used >= limit) return false;
    await this.kvSet(key, used + 1);
    return true;
  }
  budgetUsed(name: string) { return this.kvGet<number>(`budget:${name}:${today()}`, 0); }
}

/** Runs driver calls one at a time: the app's SQLite pool must never see two writers at once. */
export function serialized(d: Driver): Driver {
  let chain: Promise<unknown> = Promise.resolve();
  const queue = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => undefined);
    return p;
  };
  return { run: (s, p) => queue(() => d.run(s, p)), all: (s, p) => queue(() => d.all(s, p)) };
}
