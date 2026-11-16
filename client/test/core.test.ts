import { beforeEach, describe, expect, it } from "vitest";
import { env } from "../src/core/env";
import { handle } from "../src/core/api";
import { manager } from "../src/core/sync";
import * as justwatch from "../src/core/justwatch";
import * as ratings from "../src/core/ratings";
import { SyncContext } from "../src/core/context";
import * as settingsMod from "../src/core/settings";
import { audioTags, justwatchTech, norm, providerKey, qualityFromLabel, videoTags } from "../src/core/quality";
import { DNP, NFX, OPL, fakeFetch, freshEnv, node, offer, type Fake } from "./helpers";

const api = (method: string, path: string, body?: unknown) => {
  const u = new URL(path, "http://app");
  return handle(method, u.pathname, u.searchParams, body) as Promise<any>;
};

async function waitIdle() {
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (!manager.running.size) { await new Promise((r) => setTimeout(r, 20)); if (!manager.running.size) return; }
  }
  throw new Error("sync did not finish");
}

describe("quality helpers (same results as the Python server)", () => {
  it("normalises", () => {
    expect(qualityFromLabel("_4K")).toBe("UHD");
    expect(qualityFromLabel("HD")).toBe("HD");
    expect(justwatchTech(["DOLBY_VISION", "HDR10"], "video")).toEqual(["DV", "HDR10"]);
    expect(justwatchTech(["DOLBY_ATMOS", "_5_POINT_1"], "audio")).toEqual(["Atmos", "5.1"]);
    expect(videoTags(["HDR10 HDR"], "hevc")).toEqual(["HDR10", "HEVC"]);
    expect(audioTags(["Dolby Digital Plus Atmos"], "eac3", 6)).toEqual(["Atmos", "DD+", "5.1"]);
    expect(providerKey("Disney Plus")).toBe("disneyplus");
    expect(norm("Pelíšky & Co.")).toBe("pelisky and co");
  });
});

describe("sync progress", () => {
  it("maps step fractions to a percentage", () => {
    const c = new SyncContext("x", {} as any);
    c.progress("a", 0.5); expect(c.percent).toBe(50);
    c.step(1, 4); expect(c.percent).toBe(25);
    c.progress("b", 0.5); expect(c.percent).toBe(37);
    c.progress("c"); expect(c.percent).toBe(37);
    c.step(3, 4); c.progress("d", 1); expect(c.percent).toBe(99);
  });
});

describe("app core", () => {
  let fake: Fake;
  beforeEach(async () => {
    await freshEnv();
    fake = { calls: [], jwBodies: [], csfdBlocked: false,
      imdbTsv: "tconst\taverageRating\tnumVotes\ntt0133093\t8.7\t2100000\ntt7366338\t9.3\t900000\n",
      catalog: [
        node("tm1", "Matrix", 1999, "MOVIE", [offer(NFX), offer(OPL, { presentationType: "HD", videoTechnology: [], audioTechnology: [],
          audioLanguages: ["cs"], subtitleLanguages: [] }), offer(["mub", "MUBI", "mubi"])], { imdb: "tt0133093", tmdb: 603 }),
        node("ts2", "Černobyl", 2019, "SHOW", [offer(NFX, { audioLanguages: ["en"], subtitleLanguages: ["cs", "sk"], availableTo: "2027-01-31" })],
          { imdb: "tt7366338" }),
        node("tm3", "Pelíšky", 1999, "MOVIE", [offer(DNP, { presentationType: "HD" })]),
        ...Array.from({ length: 12 }, (_, i) => node(`tm${100 + i}`, `Film ${100 + i}`, 2015 + (i % 3), "MOVIE", [offer(NFX)])),
      ] };
    env.fetch = fakeFetch(fake);
    justwatch.tuning.PAGE = 2;
    justwatch.tuning.CAP = 5;       // forces the release-year windows to be split
  });

  it("first run: onboarding, settings, sync, catalogue, filters, ratings", async () => {
    expect(await api("GET", "/api/auth/state")).toMatchObject({ local: true, logged_in: true });
    expect(await api("GET", "/api/onboarding")).toEqual({ pending: true });
    const s0 = await api("GET", "/api/settings");
    expect(s0.ratings.csfd).toBe(false);

    const provs = await api("GET", "/api/justwatch/providers?country=cz");
    expect(provs.items.map((p: any) => p.short_name)).toEqual(["nfx", "dnp", "mub", "opl"].sort((a, b) =>
      provs.items.find((p: any) => p.short_name === a).name.localeCompare(provs.items.find((p: any) => p.short_name === b).name)));
    expect(provs.items.some((p: any) => p.short_name === "itu")).toBe(false);      // rent/buy only
    expect(fake.jwBodies[0].variables.country).toBe("CZ");

    // wizard: country + services + ratings; saving starts the JustWatch sync (ratings follow)
    await api("PUT", "/api/settings", { country: "cz", language: "cs", justwatch: { enabled: true, providers: ["nfx", "opl", "dnp"] },
      ratings: { imdb_dataset: true, tvmaze: true, tmdb_api_key: "tmdbkey", omdb_api_key: "omdbkey" } });
    await api("POST", "/api/onboarding/done");
    expect(await api("GET", "/api/onboarding")).toEqual({ pending: false });
    await waitIdle();

    const st = await api("GET", "/api/sync/status");
    const byId = Object.fromEntries(st.jobs.map((j: any) => [j.id, j]));
    expect(byId.justwatch.last.status).toBe("ok");
    expect(byId.ratings.last.status).toBe("ok");
    expect(st.last_full).toBe(0);    // single jobs do not count as a full run

    // window splitting: every one of the 12 films from 2015–2017 arrived despite CAP=5
    const stats = await api("GET", "/api/stats");
    expect(stats.titles).toBe(15);
    expect(stats.sources).toContain("justwatch");
    expect((await api("GET", "/api/sync/progress")).running).toEqual([]);
    const popular = fake.jwBodies.filter((b) => b.operationName === "GetPopularTitles");
    expect(popular[0].variables.popularTitlesFilter).toMatchObject({ packages: ["nfx"], objectTypes: ["MOVIE"] });
    expect(popular.some((b) => b.variables.popularTitlesFilter.releaseYear.min === 2015 && b.variables.popularTitlesFilter.releaseYear.max === 2016)).toBe(true);

    // hydrate: offers, quality, tags, links, MUBI (not selected) ignored, ratings merged
    const cat = await api("GET", "/api/catalog?q=matrix");
    const m = cat.items[0];
    expect(m.title).toBe("Matrix");
    expect(m.where.map((o: any) => o.provider)).toEqual(["netflix", "oneplay"]);
    expect(m.where[0]).toMatchObject({ quality: "UHD", video: ["DV"], audio: ["Atmos"], audio_langs: ["cs", "en"], url: "https://www.netflix.com/x" });
    expect(m.poster).toBe("https://images.justwatch.com/poster/tm1/{profile}/p.jpg");
    const r = Object.fromEntries(m.ratings.map((x: any) => [x.source, x.display]));
    expect(r).toMatchObject({ imdb: "8.7", tmdb: "8.5", rottentomatoes: "88 %", metacritic: "73/100" });
    const ch = (await api("GET", "/api/catalog?q=cernobyl")).items[0];
    expect(Object.fromEntries(ch.ratings.map((x: any) => [x.source, x.display]))).toMatchObject({ imdb: "9.3", tvmaze: "8.9", tmdb: "8.5" });
    expect(ch.where[0].expires_on).toBe("2027-01-31");

    // offers follow the user's service order; reordering does not start a sync
    await api("PUT", "/api/settings", { justwatch: { providers: ["opl", "nfx", "dnp"] } });
    expect(manager.running.size).toBe(0);
    expect((await api("GET", "/api/catalog?q=matrix")).items[0].where.map((o: any) => o.provider)).toEqual(["oneplay", "netflix"]);
    await api("PUT", "/api/settings", { justwatch: { providers: ["nfx", "opl", "dnp"] } });

    // multi-select filters: OR inside a filter, AND across filters, on the same offer
    const titles = async (qs: string) => (await api("GET", `/api/catalog?page_size=200&${qs}`)).items.map((i: any) => i.title).sort();
    expect(await titles("provider=oneplay")).toEqual(["Matrix"]);
    expect(await titles("provider=oneplay,disneyplus")).toEqual(["Matrix", "Pelíšky"]);
    expect(await titles("quality=HD")).toEqual(["Matrix", "Pelíšky"]);
    expect(await titles("provider=netflix&quality=HD")).toEqual([]);
    expect(await titles("type=show")).toEqual(["Černobyl"]);
    expect(await titles("sub=sk")).toEqual(["Černobyl"]);
    expect((await titles("lang=en,cs")).length).toBe(15);
    expect((await api("GET", "/api/catalog?sort=imdb&page_size=2")).items.map((i: any) => i.title)).toEqual(["Černobyl", "Matrix"]);
    expect((await api("GET", "/api/catalog?sort=title&order=asc&page_size=1")).items[0].title).toBe("Film 100");

    const f = await api("GET", "/api/facets");
    expect(f.quality.map((x: any) => x.value)).toEqual(["UHD", "HD"]);
    expect(f.audio_langs.map((x: any) => x.value).sort()).toEqual(["cs", "en"]);
    expect((await api("GET", "/api/providers")).items.map((p: any) => p.provider).sort()).toEqual(["disneyplus", "netflix", "oneplay"]);

    // secrets are masked and kept when the masked value comes back
    const s1 = await api("GET", "/api/settings");
    expect(s1.ratings.tmdb_api_key).toBe(settingsMod.MASK);
    await api("PUT", "/api/settings", s1);
    expect((await settingsMod.load()).ratings.tmdb_api_key).toBe("tmdbkey");

    // a title that left the service disappears after the next successful run
    fake.catalog = fake.catalog.filter((n) => n.id !== "tm3");
    await manager.run();
    await waitIdle();
    expect(await titles("provider=disneyplus")).toEqual([]);
    expect((await api("GET", "/api/sync/status")).last_full).toBeGreaterThan(0);
  });

  it("ČSFD is opt-in and stops cleanly on the anti-bot page", async () => {
    await api("PUT", "/api/settings", { justwatch: { providers: ["nfx"] }, ratings: { imdb_dataset: false, tvmaze: false } });
    await waitIdle();
    expect(fake.calls.some((c) => c.includes("csfd.cz"))).toBe(false);
    const s = await settingsMod.load();
    s.ratings.csfd = true;
    await settingsMod.save(s);   // hidden in the catalogue while the source is switched off
    const ctx = new SyncContext("ratings", s);
    fake.csfdBlocked = true;
    await ratings.csfd(ctx);
    expect(ctx.partial).toBe(true);
    expect(ctx.notes.join()).toContain("anti-bot");
    fake.csfdBlocked = false;
    const ctx2 = new SyncContext("ratings", s);
    await ratings.csfd(ctx2);
    const m = (await api("GET", "/api/catalog?q=matrix")).items[0];
    expect(m.ratings.find((x: any) => x.source === "csfd").display).toBe("91 %");
    expect(m.ids.csfd).toBe("9499");
  });

  it("version check uses the app-v tags only", async () => {
    const v = await api("GET", "/api/version?refresh=1");
    expect(v).toMatchObject({ current: "0.1.3", latest: "0.1.4", state: "update" });
  });

  it("keeps two works of the same name apart and repairs old mixes", async () => {
    const st = await import("../src/core/store");
    const drama = await st.upsertTitle({ type: "show", title: "Zrádci", year: 2020, ids: { jw: "tsX1", tmdb_tv: "97547" } });
    const reality = await st.upsertTitle({ type: "show", title: "Zrádci", year: 2024, ids: { imdb: "tt33321873", tmdb_tv: "271587" } });
    const bridge = await st.upsertTitle({ type: "show", title: "Zrádci", year: 2024, ids: { tmdb_tv: "97547", imdb: "tt33321873" } });
    const close = await st.upsertTitle({ type: "show", title: "Zrádci", year: 2021, ids: { tmdb_tv: "97547", imdb: "tt10720694" } });
    expect(new Set([drama, reality, bridge]).size).toBe(3);
    expect(close).toBe(drama);
    await env.db.run("INSERT INTO title_ids(kind, value, title_id) VALUES('tmdb_tv', '999999', ?)", [reality]);
    expect(await st.repairMixedTitles()).toBe(1);
    expect(await env.db.get("SELECT 1 AS x FROM titles WHERE id=?", [reality])).toBeFalsy();
  });

  it("server-only endpoints answer 404", async () => {
    await expect(api("POST", "/api/servers", {})).rejects.toMatchObject({ status: 404 });
  });
});
