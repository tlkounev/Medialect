// The refresh button on a title: that one title again from every source, then its ratings
// (port of app/refresh.py).
import { SyncContext } from "./context";
import { env, SourceError } from "./env";
import * as ivysilani from "./ivysilani";
import * as justwatch from "./justwatch";
import { jwProviders } from "./queries";
import * as ratings from "./ratings";
import { serverRefresh } from "./servers";
import * as settingsMod from "./settings";
import type { RefreshTitle } from "./store";

async function loadTitle(titleId: number): Promise<RefreshTitle | null> {
  const row = await env.db.get("SELECT id, type, title, original_title, year FROM titles WHERE id=?", [titleId]);
  if (!row) return null;
  const ids: Record<string, string> = {};
  for (const r of await env.db.all("SELECT kind, value FROM title_ids WHERE title_id=?", [titleId])) ids[r.kind] = r.value;
  const offers = (await env.db.all("SELECT source, url, extra FROM availability WHERE title_id=?", [titleId])).map((r: any) => {
    let extra = {};
    try { extra = JSON.parse(r.extra || "{}") || {}; } catch { /* not JSON */ }
    return { source: r.source, url: r.url, extra };
  });
  return { ...(row as any), ids, offers };
}

/** Own servers, JustWatch and iVysílání for this title at the same time, then every rating source. Returns
 *  what could not be refreshed (empty = all done). */
export async function refreshTitle(titleId: number): Promise<string[]> {
  const s: any = await settingsMod.load();
  const title = await loadTitle(titleId);
  if (!title) return [];
  const ctx = new SyncContext("refresh", s);
  const jobs: [string, (t: RefreshTitle, c: SyncContext) => Promise<void>][] = [];
  for (const srv of s.servers || []) {
    if (srv.enabled !== false && srv.url) jobs.push([srv.name || srv.type, (t, c) => serverRefresh(srv, t, c)]);
  }
  if (s.justwatch?.enabled && jwProviders(s.justwatch.providers).length) jobs.push(["JustWatch", justwatch.refreshTitle]);
  if (ivysilani.selected(s)) jobs.push(["iVysílání", ivysilani.refreshTitle]);
  const notes = (await Promise.all(jobs.map(async ([label, fn]) => {
    try { await fn(title, ctx); return null; }
    catch (e) {
      const msg = e instanceof SourceError ? e.message : (e as Error)?.message || String(e);
      return msg.includes(label) ? msg : `${label}: ${msg}`;
    }
  }))).filter(Boolean) as string[];
  return [...notes, ...(await ratings.refreshTitle(titleId, s))];
}
