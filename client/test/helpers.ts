import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { Db, serialized, type Driver } from "../src/core/db";
import { env } from "../src/core/env";

export function nodeDriver(): Driver {
  const db = new DatabaseSync(":memory:");
  return {
    async run(sql, params) {
      const r = db.prepare(sql).run(...(params as any[]));
      return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
    },
    async all(sql, params) { return db.prepare(sql).all(...(params as any[])) as any[]; },
  };
}

export async function freshEnv(): Promise<Db> {
  env.db = new Db(serialized(nodeDriver()));
  env.sleep = async () => {};
  env.version = "0.1.3";
  await env.db.open();
  return env.db;
}

// ---- fake remote services ------------------------------------------------------------------
export function offer(pkg: [string, string, string], extra: Record<string, unknown> = {}) {
  const [shortName, clearName, technicalName] = pkg;
  return { monetizationType: "FLATRATE", presentationType: "_4K", standardWebURL: `https://www.${technicalName}.com/x`,
    package: { shortName, clearName, technicalName, icon: "/icon/1/s100/x.png" },
    videoTechnology: ["DOLBY_VISION"], audioTechnology: ["DOLBY_ATMOS"], audioLanguages: ["cs", "en"], subtitleLanguages: ["cs"], ...extra };
}
export const NFX: [string, string, string] = ["nfx", "Netflix", "netflix"];
export const OPL: [string, string, string] = ["opl", "Oneplay", "oneplay"];
export const DNP: [string, string, string] = ["dnp", "Disney Plus", "disneyplus"];

export function node(id: string, title: string, year: number, type: "MOVIE" | "SHOW", offers: any[], ids: { imdb?: string; tmdb?: number } = {}) {
  return { id, objectId: 1, objectType: type, offers,
    content: { title, originalReleaseYear: year, fullPath: `/cz/film/${id}`, posterUrl: `/poster/${id}/{profile}/p.jpg`,
      externalIds: { imdbId: ids.imdb ?? null, tmdbId: ids.tmdb ?? null },
      scoring: { imdbScore: 7.1, imdbVotes: 10, tmdbScore: 6.4, tomatoMeter: 77 } } };
}

export interface Fake { catalog: any[]; calls: string[]; jwBodies: any[]; imdbTsv: string; csfdBlocked?: boolean }

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export function fakeFetch(f: Fake) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    f.calls.push(`${init?.method || "GET"} ${u.host}${u.pathname}${u.search}`);
    if (u.host === "apis.justwatch.com") {
      const body = JSON.parse(String(init?.body));
      f.jwBodies.push(body);
      if (body.operationName === "GetProviders") {
        return json({ data: { packages: [NFX, OPL, DNP, ["mub", "MUBI", "mubi"]].map(([shortName, clearName, technicalName]) =>
          ({ shortName, clearName, technicalName, icon: "/icon/x.png", monetizationTypes: ["FLATRATE"] }))
          .concat([{ shortName: "itu", clearName: "Apple iTunes", technicalName: "itunes", icon: "", monetizationTypes: ["RENT", "BUY"] }]) } });
      }
      const v = body.variables, flt = v.popularTitlesFilter;
      const hits = f.catalog.filter((n) => flt.objectTypes.includes(n.objectType)
        && n.offers.some((o: any) => flt.packages.includes(o.package.shortName))
        && n.content.originalReleaseYear >= flt.releaseYear.min && n.content.originalReleaseYear <= flt.releaseYear.max);
      const offset = v.offset || 0;
      if (offset + v.first > 1999 + 1) return json({ data: { popularTitles: { edges: [] } } });
      return json({ data: { popularTitles: { edges: hits.slice(offset, offset + v.first).map((n) => ({ node: n })) } } });
    }
    if (u.host === "datasets.imdbws.com") {
      return new Response(gzipSync(Buffer.from(f.imdbTsv)), { status: 200, headers: { "content-type": "application/gzip" } });
    }
    if (u.host === "api.themoviedb.org") {
      if (u.searchParams.get("api_key") !== "tmdbkey") return json({ status_message: "Invalid API key" }, 401);
      if (u.pathname.startsWith("/3/find/")) return json({ movie_results: [], tv_results: [{ id: 87108 }] });
      return json({ vote_average: 8.5, vote_count: 1234 });
    }
    if (u.host === "api.tvmaze.com") {
      if (u.searchParams.get("imdb") === "tt7366338") return json({ url: "https://www.tvmaze.com/shows/1", rating: { average: 8.9 } });
      return json(null, 404);
    }
    if (u.host === "www.omdbapi.com") {
      return json({ Response: "True", Ratings: [{ Source: "Rotten Tomatoes", Value: "88%" }, { Source: "Metacritic", Value: "73/100" }] });
    }
    if (u.host === "www.csfd.cz") {
      if (f.csfdBlocked) return new Response('<html><div id="anubis_challenge"></div></html>', { status: 200 });
      if (u.pathname === "/hledat/") {
        return new Response(`<article><a href="/film/9499-matrix/prehled/" class="film-title-name">Matrix</a> (1999)</article>`, { status: 200 });
      }
      return new Response(`<div class="film-header"></div><div class="film-rating-average">91%</div>
        <a href="https://www.imdb.com/title/tt0133093/">IMDb</a>`, { status: 200 });
    }
    if (u.host === "api.github.com") return json([{ name: "app-v0.1.4" }, { name: "v1.0.9" }, { name: "app-v0.1.2" }]);
    return json({ detail: `unexpected ${url}` }, 599);
  };
}
