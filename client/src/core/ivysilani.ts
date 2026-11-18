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

const QUERY = `query GetCategoryById($limit: PaginationAmount!, $offset: Int!, $categoryId: String!,
  $order: OrderByDirection, $orderBy: CategoryOrderByType) {
  showFindByGenre(limit: $limit, offset: $offset, categoryId: $categoryId, order: $order, orderBy: $orderBy) {
    items { id slug title year __typename }
    totalCount
  }
}`;

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

async function page(category: string, offset: number): Promise<[any[], number]> {
  const json = { operationName: "GetCategoryById", query: QUERY,
    variables: { categoryId: category, limit: PAGE, offset, order: "asc", orderBy: "alphabet" } };
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await http(API, { json, headers: { Referer: "https://www.ceskatelevize.cz/", Origin: "https://www.ceskatelevize.cz" } });
      if (r.ok) {
        const found = r.data?.data?.showFindByGenre;
        if (!found) throw new SourceError(`iVysílání: neočekávaná odpověď ${JSON.stringify(r.data?.errors || r.text).slice(0, 200)}`);
        return [found.items || [], Number(found.totalCount || 0)];
      }
      last = `HTTP ${r.status}`;
    } catch (e) {
      if ((e as Error).message?.startsWith("iVysílání:")) throw e;
      last = (e as Error).message || String(e);
    }
    await env.sleep(3000 * (attempt + 1));
  }
  throw new SourceError(`iVysílání nedostupné: ${last}`);
}

export async function sync(ctx: SyncContext): Promise<void> {
  const started = Date.now() / 1000;
  for (const [i, [category, type, label]] of CATEGORIES.entries()) {
    ctx.step(i, CATEGORIES.length);
    let offset = 0, total: number | null = null;
    while (total === null || offset < total) {
      ctx.progress(`iVysílání – ${label}`, total ? offset / total : 0);
      const [items, count] = await page(category, offset);
      total = count;
      if (!items.length) break;
      for (const it of items) {
        if (!it?.id || !it?.title) continue;
        const tid = await store.upsertTitle({ type, title: String(it.title).trim(), year: yearOf(it.year), ids: { ct: String(it.id) } });
        await store.upsertOffer(tid, { source: PROVIDER, provider: PROVIDER, provider_name: NAME, kind: "stream", monetization: "free",
          url: `${WEB}${it.slug || it.id}/`, audio_langs: ["cs"] }, started);
        ctx.items++;
      }
      offset += PAGE;
      await env.sleep(DELAY_MS);
    }
  }
  const removed = await store.removeStale(PROVIDER, started);
  ctx.note(`iVysílání: ${ctx.items} pořadů${removed ? `, ${removed} už nedostupných odebráno` : ""}`);
}
