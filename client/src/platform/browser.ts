// Plain-browser driver (development preview only): SQLite compiled to WebAssembly, kept in memory.
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { Driver, Param } from "../core/db";

export async function browserDriver(): Promise<Driver> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const db = new SQL.Database();
  return {
    async run(sql: string, params: Param[]) {
      db.run(sql, params as any);
      const id = db.exec("SELECT last_insert_rowid() AS id")[0]?.values[0][0];
      return { changes: db.getRowsModified(), lastId: Number(id ?? 0) };
    },
    async all(sql: string, params: Param[]) {
      const stmt = db.prepare(sql);
      stmt.bind(params as any);
      const rows: Record<string, any>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
  };
}
