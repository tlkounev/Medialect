// iVysílání (Česká televize): its free films and series, read from the GraphQL API its own web uses
// (port of app/sources/ivysilani.py). Titles are paired with the catalogue by name + year.
import { env, http, SourceError } from "./env";
import * as store from "./store";
import type { SyncContext } from "./context";
import type { ProviderInfo } from "./justwatch";

export const SHORT_NAME = "ivy";
export const PROVIDER = "ivysilani";
export const NAME = "iVysílání";
export const ICON = "https://icons.duckduckgo.com/ip3/www.ceskatelevize.cz.ico";
const COUNTRIES = ["CZ"];
const API = "https://api.ceskatelevize.cz/graphql/";
const WEB = "https://www.ceskatelevize.cz/porady/";
const CATEGORIES: [string, "movie" | "show", string][] = [["3947", "movie", "filmy"], ["3976", "show", "seriály"]];
const PAGE = 40;              // the API answers 400 above 40
const DELAY_MS = 400;

// The API is not documented: the richer variants ask for a picture in the field names ČT's own pages use;
// when the API rejects one, the next (and finally the bare list without pictures) is used.
const LIST = (extra: string) => `query GetCategoryById($limit: PaginationAmount!, $offset: Int!, $categoryId: String!,
  $order: OrderByDirection, $orderBy: CategoryOrderByType) {
  showFindByGenre(limit: $limit, offset: $offset, categoryId: $categoryId, order: $order, orderBy: $orderBy) {
    items { id slug title year ${extra} __typename }
    totalCount
  }
}`;
export const QUERIES = [LIST("images { card(width: 480) }"), LIST("imageUrl(width: 480, height: 270)"), LIST("")];

export const providerInfo = (): ProviderInfo =>
  ({ short_name: SHORT_NAME, name: NAME, technical_name: PROVIDER, icon: ICON, monetization_types: ["FREE"] });

/** Adds iVysílání to the country's service list, so it is picked and ordered like the others. */
export async function register(country: string, items: ProviderInfo[]): Promise<ProviderInfo[]> {
  if (!COUNTRIES.includes(country.toUpperCase())) return items;
  if (env.db) {
    const keys = await env.db.kvGet<Record<string, string>>("jw.provider_keys", {});
    keys[SHORT_NAME] = PROVIDER;
    await env.db.kvSet("jw.provider_keys", keys);
    const icons = await env.db.kvGet<Record<string, string>>("jw.provider_icons", {});
    icons[PROVIDER] = ICON;
    await env.db.kvSet("jw.provider_icons", icons);
  }
  return [...items, providerInfo()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

export const selected = (s: { country?: string; justwatch?: { providers?: string[] } }) =>
  COUNTRIES.includes((s.country || "").toUpperCase()) && (s.justwatch?.providers || []).includes(SHORT_NAME);

export function yearOf(v: unknown): number | null {
  const m = String(v ?? "").match(/(1[89]|20)\d\d/);
  return m ? Number(m[0]) : null;
}

export function picture(it: any): string | null {
  const url: string | undefined = (it?.images && typeof it.images === "object" ? it.images.card : undefined) || it?.imageUrl;
  if (!url) return null;
  return url.startsWith("//") ? `https:${url}` : url;
}

async function page(category: string, offset: number, variant: { i: number }): Promise<[any[], number]> {
  let last = "";
  for (let attempt = 0; attempt < 4;) {
    const json = { operationName: "GetCategoryById", query: QUERIES[variant.i],
      variables: { categoryId: category, limit: PAGE, offset, order: "asc", orderBy: "alphabet" } };
    try {
      const r = await http(API, { json, headers: { Referer: "https://www.ceskatelevize.cz/", Origin: "https://www.ceskatelevize.cz" } });
      const found = r.data?.data?.showFindByGenre;
      if (found) return [found.items || [], Number(found.totalCount || 0)];
      if (r.data?.errors && variant.i < QUERIES.length - 1) { variant.i++; continue; }   // a field the API does not know
      if (r.data?.errors) throw new SourceError(`iVysílání: neočekávaná odpověď ${JSON.stringify(r.data.errors).slice(0, 200)}`);
      last = `HTTP ${r.status}`;
    } catch (e) {
      if ((e as Error).message?.startsWith("iVysílání:")) throw e;
      last = (e as Error).message || String(e);
    }
    attempt++;
    await env.sleep(3000 * attempt);
  }
  throw new SourceError(`iVysílání nedostupné: ${last}`);
}

export async function sync(ctx: SyncContext): Promise<void> {
  const started = Date.now() / 1000;
  const variant = { i: await env.db.kvGet<number>("ivysilani.query", 0) };
  for (const [i, [category, type, label]] of CATEGORIES.entries()) {
    ctx.step(i, CATEGORIES.length);
    let offset = 0, total: number | null = null;
    while (total === null || offset < total) {
      ctx.progress(`iVysílání – ${label}`, total ? offset / total : 0);
      const [items, count] = await page(category, offset, variant);
      total = count;
      if (!items.length) break;
      for (const it of items) {
        if (!it?.id || !it?.title) continue;
        const tid = await store.upsertTitle({ type, title: String(it.title).trim(), year: yearOf(it.year), poster: picture(it),
          ids: { ct: String(it.id) } });
        await store.upsertOffer(tid, { source: PROVIDER, provider: PROVIDER, provider_name: NAME, kind: "stream", monetization: "free",
          url: `${WEB}${it.slug || it.id}/`, audio_langs: ["cs"] }, started);
        ctx.items++;
      }
      offset += PAGE;
      await env.sleep(DELAY_MS);
    }
  }
  await env.db.kvSet("ivysilani.query", variant.i);
  const removed = await store.removeStale(PROVIDER, started);
  ctx.note(`iVysílání: ${ctx.items} pořadů${removed ? `, ${removed} už nedostupných odebráno` : ""}`);
}

/** One title again: its iVysílání page still there? (The API lists whole categories only, so a title new on
 *  iVysílání arrives with the next full synchronisation.) */
export async function refreshTitle(title: store.RefreshTitle, _ctx: SyncContext): Promise<void> {
  for (const o of title.offers) {
    if (o.source !== PROVIDER || !o.url) continue;
    const r = await http(o.url);
    if (r.status === 404) await env.db.run("DELETE FROM availability WHERE title_id=? AND source=? AND url=?", [title.id, PROVIDER, o.url]);
    else if (r.status >= 400) throw new SourceError(`iVysílání HTTP ${r.status}`);
  }
}
