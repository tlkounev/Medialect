// Tauri adapters: SQLite through tauri-plugin-sql, HTTP through tauri-plugin-http (no CORS limits).
import Database from "@tauri-apps/plugin-sql";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { Driver, Param } from "../core/db";

export async function sqlDriver(file = "sqlite:medialect.db"): Promise<Driver> {
  const db = await Database.load(file);
  return {
    async run(sql: string, params: Param[]) {
      const r = await db.execute(sql, params);
      return { changes: r.rowsAffected, lastId: Number(r.lastInsertId ?? 0) };
    },
    all: (sql: string, params: Param[]) => db.select<Record<string, any>[]>(sql, params),
  };
}

export const httpFetch = (url: string, init?: RequestInit) => tauriFetch(url, init);
