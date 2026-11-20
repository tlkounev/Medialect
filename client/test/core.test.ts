import { beforeEach, describe, expect, it } from "vitest";
import { env } from "../src/core/env";
import { handle } from "../src/core/api";
import { manager } from "../src/core/sync";
import * as justwatch from "../src/core/justwatch";
import * as ratings from "../src/core/ratings";
import { SyncContext } from "../src/core/context";
import * as settingsMod from "../src/core/settings";
import { audioTags, justwatchTech, norm, providerKey, providerName, qualityFromLabel, videoTags } from "../src/core/quality";
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
  it("names a service the way the service does", () => {
    expect(providerName("Prima plus")).toBe("Prima+");
    expect(providerName("Netflix")).toBe("Netflix");
  });

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

describe("app permissions", () => {
  it("HTTP is allowed to any host and port (the user's own media servers)", async () => {
    const { readFileSync } = await import("node:fs");
    const cap = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"));
    const urls = cap.permissions.find((p: any) => p.identifier === "http:default").allow.map((a: any) => a.url);
    expect(urls).toEqual(expect.arrayContaining(["http://*:*", "https://*:*"]));
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
    expect(provs.items.map((p: any) => p.short_name)).toEqual(["nfx", "dnp", "mub", "opl", "ivy"].sort((a, b) =>
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
    const nfxOffer = (await api("GET", "/api/catalog?q=matrix")).items[0].where.find((w: any) => w.provider === "netflix");
    expect(nfxOffer.icon).toMatch(/^https:\/\/images\.justwatch\.com\//);   // logo instead of the name
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

    // a run that ended with an error (or was cut off by closing the app) continues after the next start
    expect(await manager.unfinished()).toEqual([]);
    await env.db.run("UPDATE sync_runs SET status='error' WHERE id=(SELECT MAX(id) FROM sync_runs WHERE source='justwatch')");
    expect(await manager.unfinished()).toEqual(["justwatch"]);
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

  it("JustWatch: an unreachable window is skipped, the rest is stored", async () => {
    const real = env.fetch;
    env.fetch = async (url, init) => {
      const b = init?.body ? JSON.parse(String(init.body)) : null;
      if (b?.variables?.popularTitlesFilter?.releaseYear?.min === 1990) throw new Error("error sending request for url");
      return real(url, init);
    };
    const s = await settingsMod.load();
    s.justwatch.enabled = true; s.justwatch.providers = ["nfx"]; s.justwatch.request_delay_s = 0;
    const ctx = new SyncContext("justwatch", s);
    await justwatch.sync(ctx);
    expect(ctx.partial).toBe(true);
    expect(ctx.notes.join()).toContain("1990–1999");
    const cat = await api("GET", "/api/catalog?q=cernobyl");
    expect(cat.items.length).toBe(1);                       // 2019 series arrived
    expect((await api("GET", "/api/catalog?q=matrix")).items.length).toBe(0);   // 1999 window failed
  });

  it("JustWatch: services in the user's order, newest first, an interrupted run continues where it stopped", async () => {
    const s = await settingsMod.load();
    s.justwatch.enabled = true; s.justwatch.providers = ["opl", "nfx"]; s.justwatch.request_delay_s = 0;   // not alphabetical
    const popular = () => fake.jwBodies.filter((b) => b.operationName === "GetPopularTitles");
    const key = (b: any) => `${b.variables.popularTitlesFilter.packages[0]}|${b.variables.popularTitlesFilter.objectTypes[0]}|` +
      `${b.variables.popularTitlesFilter.releaseYear.min}|${b.variables.popularTitlesFilter.releaseYear.max}|${b.variables.offset}`;

    // first run: the network goes away after 10 requests
    const real = env.fetch;
    let n = 0;
    env.fetch = async (url, init) => {
      const b = init?.body ? JSON.parse(String(init.body)) : null;
      if (b?.operationName === "GetPopularTitles" && ++n > 10) throw new Error("error sending request for url");
      return real(url, init);
    };
    await expect(justwatch.sync(new SyncContext("justwatch", s))).rejects.toThrow(/příště naváže/);
    const first = popular().slice(0, 10);
    expect(first[0].variables.popularTitlesFilter.packages[0]).toBe("opl");          // priority, not alphabet
    expect(first[0].variables.popularTitlesFilter.releaseYear.min).toBe(new Date().getFullYear() + 2);   // newest first
    const okKeys = new Set(first.map(key));

    // second run: continues, nothing finished is fetched again, the checkpoint is gone at the end
    env.fetch = real;
    const before = popular().length;
    const ctx = new SyncContext("justwatch", s);
    await justwatch.sync(ctx);
    expect(ctx.notes.join()).toContain("Navazuji");
    const second = popular().slice(before);
    const finishedFirst = [...okKeys].filter((k) => !second.some((b) => key(b) === k));
    expect(finishedFirst.length).toBeGreaterThanOrEqual(8);   // the window being fetched when it broke is repeated
    expect(await env.db.kvGet("jw.resume", null)).toBeNull();
    expect((await api("GET", "/api/catalog?q=matrix")).items.length).toBe(1);
  });

  it("JustWatch: the date an offer came to the service is kept; the oldest date of a title sorts it", async () => {
    fake.catalog = [node("tm1", "Matrix", 1999, "MOVIE", [offer(NFX, { dateCreated: "2021-03-05" }), offer(OPL, { dateCreated: "2025-01-10" })], { imdb: "tt0133093" }),
      node("tm9", "Nový film", 2026, "MOVIE", [offer(NFX, { dateCreated: "2026-11-01" })])];
    const s = await settingsMod.load();
    s.justwatch.enabled = true; s.justwatch.providers = ["nfx", "opl"]; s.justwatch.request_delay_s = 0;
    await justwatch.sync(new SyncContext("justwatch", s));
    expect(fake.jwBodies.find((b) => b.operationName === "GetPopularTitles").query).toContain("dateCreated");
    const dates = (await env.db.all("SELECT provider, added_at FROM availability ORDER BY provider")).map((r) => `${r.provider}:${r.added_at}`);
    expect(dates).toContain("netflix:2021-03-05");
    const cat = await api("GET", "/api/catalog?sort=added&order=desc");
    expect(cat.items.map((i: any) => i.title)).toEqual(["Nový film", "Matrix"]);   // Matrix counts from 2021
  });

  it("two films of the same name: other IMDb ids keep them apart, a wrongly joined catalogue entry leaves", async () => {
    const st = await import("../src/core/store");
    const lib = await st.upsertTitle({ type: "movie", title: "Odyssea X", year: 2026, library: true,
      ids: { imdb: "tt9990001", tmdb_movie: "9001", tvdb: "77", csfd: "123" } });
    await st.upsertOffer(lib, { source: "emby:x", provider: "emby-x", provider_name: "Emby", kind: "library", monetization: "library" }, 1);
    const other = await st.upsertTitle({ type: "movie", title: "Odyssea X", year: 2026, ids: { imdb: "tt9990002", tmdb_movie: "9002", jw: "tm999" } });
    expect(other).not.toBe(lib);
    // the old state: the catalogue entry joined to the library film, with a rating it brought
    await env.db.run("UPDATE title_ids SET title_id=? WHERE kind='jw' AND value='tm999'", [lib]);
    await env.db.run("INSERT OR REPLACE INTO ratings(title_id, source, value, display, updated_at) VALUES(?, 'tmdb', 10, '1.0', 0)", [lib]);
    const again = await st.upsertTitle({ type: "movie", title: "Odyssea X", year: 2026, ids: { imdb: "tt9990002", tmdb_movie: "9002", jw: "tm999" } });
    expect(again).not.toBe(lib);
    expect((await env.db.all("SELECT source FROM ratings WHERE title_id=?", [lib])).map((r) => r.source)).not.toContain("tmdb");
  });

  it("service order includes own servers: offers and the ČSFD queue follow it", async () => {
    const st = await import("../src/core/store");
    const q = await import("../src/core/queries");
    const s = await settingsMod.load();
    await env.db.kvSet("settings", { ...s, servers: [{ id: "abc", type: "emby", name: "Doma", url: "http://10.0.0.10:8096" }],
      justwatch: { ...s.justwatch, providers: ["nfx", "srv:abc", "ivy"] } });
    await env.db.kvSet("jw.provider_keys", { nfx: "netflix", ivy: "ivysilani" });
    const a = await st.upsertTitle({ type: "movie", title: "Jen doma", year: 2001 });
    const b = await st.upsertTitle({ type: "movie", title: "Jen Netflix", year: 2002 });
    const c = await st.upsertTitle({ type: "movie", title: "Jen ČT", year: 2003 });
    const off = (provider: string, kind: "stream" | "library" = "stream") =>
      ({ source: kind === "library" ? "emby:abc" : provider, provider, provider_name: provider, kind, monetization: kind === "library" ? "library" : "flatrate" });
    await st.upsertOffer(a, off("emby-abc", "library"), 1);
    await st.upsertOffer(b, off("netflix"), 1);
    await st.upsertOffer(c, off("ivysilani"), 1);
    await st.upsertOffer(a, off("netflix"), 1);
    expect(q.jwProviders(["nfx", "srv:abc", "ivy"])).toEqual(["nfx"]);
    const [rank, params] = await q.rankSql();
    const ids = (await env.db.all(`SELECT t.id FROM titles t ORDER BY ${rank}, t.id`, params)).map((r) => r.id);
    expect(ids).toEqual([a, b, c]);       // a and b both on Netflix (1st), c on iVysílání (3rd)
    const [hyd] = await q.hydrate([a]);
    expect(hyd.where.map((o: any) => o.provider)).toEqual(["netflix", "emby-abc"]);   // the user's order, not "library first"
  });

  it("a series in the library and on a service is one title even when one id disagrees", async () => {
    const st = await import("../src/core/store");
    const lib = (title: string, ids: Record<string, string>) => st.upsertTitle({ type: "show", title, year: 2022, ids, library: true });
    const jw = await st.upsertTitle({ type: "show", title: "Star Trek: Podivné nové světy", year: 2022, ids: { jw: "tsST", imdb: "tt12327578", tmdb_tv: "103516" } });
    await st.upsertOffer(jw, { source: "justwatch", provider: "skyshowtime", provider_name: "SkyShowtime", kind: "stream", monetization: "flatrate" }, 1);
    const emby = await lib("Star Trek: Podivné nové světy", { imdb: "tt12327578", tmdb_tv: "999999", tvdb: "382389" });
    expect(emby).toBe(jw);
    const kinds = await env.db.all("SELECT kind, value FROM title_ids WHERE title_id=? ORDER BY kind", [jw]);
    expect(kinds.filter((k) => k.kind === "tmdb_tv").map((k) => k.value)).toEqual(["999999"]);   // one value: the library's
    // titles kept apart by an older version are joined after the next synchronisation
    const a = (await env.db.run("INSERT INTO titles(type, title, year, created_at, updated_at) VALUES('show','Andor',2022,1,1)")).lastId;
    const b = (await env.db.run("INSERT INTO titles(type, title, year, created_at, updated_at) VALUES('show','Andor',2022,1,1)")).lastId;
    for (const t of [a, b]) await env.db.run("INSERT INTO title_names(title_id, norm) VALUES(?, 'andor')", [t]);
    await env.db.run("INSERT INTO title_ids(kind, value, title_id) VALUES('tmdb_tv','83867',?), ('tmdb_tv','111',?), ('jw','tsA',?)", [a, b, b]);
    await st.upsertOffer(a, { source: "emby:x", provider: "emby-x", provider_name: "Doma", kind: "library", monetization: "library" }, 1);
    await st.upsertOffer(b, { source: "justwatch", provider: "disneyplus", provider_name: "Disney+", kind: "stream", monetization: "flatrate" }, 1);
    expect(await st.mergeLibraryTwins()).toBe(1);
    expect((await env.db.all("SELECT provider FROM availability WHERE title_id=? ORDER BY provider", [a])).map((r) => r.provider)).toEqual(["disneyplus", "emby-x"]);
    expect((await env.db.get("SELECT title_id FROM title_ids WHERE kind='jw' AND value='tsA'"))!.title_id).toBe(a);
    expect(await env.db.get("SELECT 1 AS x FROM title_ids WHERE value='111'")).toBeFalsy();
    expect(await st.repairMixedTitles()).toBe(0);      // nothing left with two values of one id
  });

  it("the refresh button: one title again from JustWatch and its ratings", async () => {
    await api("PUT", "/api/settings", { country: "cz", language: "cs", justwatch: { enabled: true, providers: ["nfx", "opl"] },
      ratings: { imdb_dataset: false, tvmaze: false, tmdb_api_key: "tmdbkey", csfd: true } });
    const st = await import("../src/core/store");
    // a library title JustWatch does not know yet (no JustWatch id): found by its name, its offers added
    const id = await st.upsertTitle({ type: "movie", title: "Matrix", year: 1999, ids: { imdb: "tt0133093", csfd: "1" }, library: true });
    await st.upsertOffer(id, { source: "justwatch", provider: "disneyplus", provider_name: "Disney Plus", kind: "stream", monetization: "flatrate" }, 1);
    const item = await api("POST", `/api/titles/${id}/refresh`);
    const provs = item.where.map((w: any) => w.provider).sort();
    expect(provs).toEqual(["netflix", "oneplay"]);              // Disney+ left (not on JustWatch any more), MUBI not chosen
    expect(item.ids.jw).toBe("tm1");
    expect(item.refresh_note).toBeNull();
    const r = Object.fromEntries(item.ratings.map((x: any) => [x.source, x.display]));
    expect(r.tmdb).toBe("8.5");                                // TMDB now, not in a later ratings run
    expect(r.csfd).toBe("91 %");
    expect(item.ids.csfd).toBe("1");                           // its page links the title's IMDb id: kept
    // the title left the service: its offer goes; by the JustWatch id now
    fake.catalog[0].offers = fake.catalog[0].offers.filter((o: any) => o.package.shortName !== "opl");
    const again = await api("POST", `/api/titles/${id}/refresh`);
    expect(again.where.map((w: any) => w.provider)).toEqual(["netflix"]);
    expect(fake.jwBodies.at(-1).operationName).toBe("GetTitleNode");
  });

  it("ČSFD rates the titles on screen first", async () => {
    const st = await import("../src/core/store");
    const r = await import("../src/core/ratings");
    const ids: number[] = [];
    for (const name of ["A", "B", "C"]) {
      const id = await st.upsertTitle({ type: "movie", title: name, year: 2000 });
      await st.upsertOffer(id, { source: "justwatch", provider: "netflix", provider_name: "Netflix", kind: "stream", monetization: "flatrate" }, 1);
      ids.push(id);
    }
    const [a, b, c] = ids;
    expect((await r.csfdQueue(0)).map((x) => x.id)).toEqual([a, b, c]);
    await api("POST", "/api/ratings/focus", { ids: [c, a] });
    expect((await r.csfdQueue(0)).map((x) => x.id)).toEqual([c, a, b]);
  });

  it("keeps two works of the same name apart and repairs old mixes", async () => {
    const st = await import("../src/core/store");
    const drama = await st.upsertTitle({ type: "show", title: "Zrádci", year: 2020, ids: { jw: "tsX1", tmdb_tv: "97547" } });
    const reality = await st.upsertTitle({ type: "show", title: "Zrádci", year: 2024, ids: { imdb: "tt33321873", tmdb_tv: "271587" } });
    const bridge = await st.upsertTitle({ type: "show", title: "Zrádci", year: 2024, ids: { tmdb_tv: "97547", imdb: "tt33321873" } });
    const close = await st.upsertTitle({ type: "show", title: "Zrádci", year: 2021, ids: { tmdb_tv: "97547", imdb: "tt10720694" } });
    expect(new Set([drama, reality, bridge]).size).toBe(3);
    expect(close).toBe(drama);
    // catalogue first, library second: the library's id wins and the wrongly derived rating goes
    const jw = await st.upsertTitle({ type: "show", title: "Hra", year: 2019, ids: { jw: "tsY1", imdb: "tt9000001", tmdb_tv: "555" } });
    await st.setRating(jw, "imdb", 83, "8.3");
    const lib = await st.upsertTitle({ type: "show", title: "Hra", year: 2025, library: true, ids: { imdb: "tt9000001", tmdb_tv: "777" } });
    expect(lib).not.toBe(jw);
    expect((await env.db.get("SELECT title_id FROM title_ids WHERE kind='imdb' AND value='tt9000001'"))!.title_id).toBe(lib);
    expect(await env.db.get("SELECT 1 AS x FROM ratings WHERE title_id=?", [jw])).toBeFalsy();
    await env.db.run("INSERT INTO title_ids(kind, value, title_id) VALUES('tmdb_tv', '999999', ?)", [reality]);
    expect(await st.repairMixedTitles()).toBe(1);
    expect(await env.db.get("SELECT 1 AS x FROM titles WHERE id=?", [reality])).toBeFalsy();
  });

  it("iVysílání: listed as a Czech service, its films and series join the catalogue by name and year", async () => {
    const ivy = await import("../src/core/ivysilani");
    const st = await import("../src/core/store");
    const pelisky = await st.upsertTitle({ type: "movie", title: "Pelíšky", year: 1999, ids: { jw: "tm3" } });
    const shows: Record<string, any[]> = {
      "3947": [{ id: "10123", slug: "10123-pelisky", title: "Pelíšky", year: "1999" },
               { id: "10124", slug: "10124-vrchni-prchni", title: "Vrchní, prchni!", year: "1980" }],
      "3976": [{ id: "20001", slug: "20001-nemocnice-na-kraji-mesta", title: "Nemocnice na kraji města", year: "1977–1981" }],
    };
    const bodies: any[] = [];
    const prev = env.fetch;
    env.fetch = async (url: string, init?: RequestInit) => {
      if (new URL(url).host !== "api.ceskatelevize.cz") return prev(url, init);
      const body = JSON.parse(String(init?.body)); bodies.push({ body, headers: init?.headers });
      // the real field for pictures is not known for sure: this fake knows only the second variant
      if (body.query.includes("images {")) return new Response(JSON.stringify({ errors: [{ message: "Cannot query field \"images\"" }] }),
        { status: 400, headers: { "content-type": "application/json" } });
      const all = (shows[body.variables.categoryId] || []).map((x) => body.query.includes("imageUrl") ? { ...x, imageUrl: `//img.ceskatelevize.cz/${x.id}.jpg` } : x);
      return new Response(JSON.stringify({ data: { showFindByGenre: {
        items: all.slice(body.variables.offset, body.variables.offset + body.variables.limit), totalCount: all.length } } }),
        { headers: { "content-type": "application/json" } });
    };
    const listed = await api("GET", "/api/justwatch/providers?country=CZ");
    expect(listed.items.map((p: any) => p.short_name)).toContain("ivy");
    expect((await api("GET", "/api/justwatch/providers?country=DE")).items.map((p: any) => p.short_name)).not.toContain("ivy");
    expect(ivy.selected({ country: "CZ", justwatch: { providers: ["nfx", "ivy"] } })).toBe(true);
    const { SyncContext } = await import("../src/core/context");
    const ctx = new SyncContext("ivysilani", { country: "CZ" } as any);
    await ivy.sync(ctx);
    expect(ctx.items).toBe(3);
    expect(bodies[0].body.variables).toMatchObject({ limit: 40, offset: 0, categoryId: "3947" });
    expect(bodies.filter((b) => b.body.query.includes("images {")).length).toBe(1);   // rejected once, then remembered
    expect((await env.db.get("SELECT poster FROM titles t JOIN title_ids i ON i.title_id=t.id WHERE i.kind='ct' AND i.value='10124'"))!.poster)
      .toBe("https://img.ceskatelevize.cz/10124.jpg");
    expect((bodies[0].headers as any).Referer).toBe("https://www.ceskatelevize.cz/");
    const offer = await env.db.get("SELECT title_id, url, monetization FROM availability WHERE provider='ivysilani' AND url LIKE '%pelisky%'");
    expect(offer).toMatchObject({ title_id: pelisky, url: "https://www.ceskatelevize.cz/porady/10123-pelisky/", monetization: "free" });
    expect((await env.db.get("SELECT year FROM titles t JOIN title_ids i ON i.title_id=t.id WHERE i.kind='ct' AND i.value='20001'"))!.year).toBe(1977);
    // a title gone from iVysílání loses its offer on the next run
    shows["3947"].pop();
    await ivy.sync(new SyncContext("ivysilani", { country: "CZ" } as any));
    expect((await env.db.get("SELECT COUNT(*) AS n FROM availability WHERE provider='ivysilani'"))!.n).toBe(2);
  });

  it("languages: codes, three-letter codes and names end up as one code", async () => {
    const { lang, langs } = await import("../src/core/quality");
    expect(["cs", "cze", "ces", "cs-CZ", "Czech", "Čeština", "Czech (Forced)"].map(lang)).toEqual(Array(7).fill("cs"));
    expect(langs(["eng", "English", "en-US", "und", "Unknown", "nob", "nb", "Brazilian Portuguese", "pt-BR"])).toEqual(["en", "no", "pt"]);
    // "original" and audio description are no languages; a short word of a phrase is no language code
    expect(langs(["qaa", "qad", "org", "Original", "to be added", "as original", "pt BR", "English SDH"])).toEqual(["pt", "en"]);
  });

  it("media servers: Emby library is added, tested, synchronised and removed", async () => {
    const real = env.fetch;
    env.fetch = async (url, init) => {
      const u = new URL(url);
      if (u.host === "10.0.0.1:8096") throw new Error("error sending request for url");
      if (u.host !== "emby.test") return real(url, init);
      const j = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if ((init?.headers as any)?.["X-Emby-Token"] !== "k") return new Response("", { status: 401 });
      if (u.pathname === "/System/Info") return j({ Id: "srv1", ServerName: "Doma", Version: "4.9" });
      if (u.pathname === "/Users") return j([{ Id: "u1", Policy: { IsAdministrator: true } }]);
      if (u.pathname === "/Users/u1/Items/m4") {
        return j({ Id: "m4", MediaSources: [{ MediaStreams: [{ Type: "Audio", Language: "eng" }] }, { MediaStreams: [{ Type: "Audio", Language: "cze" }] }] });
      }
      const type = u.searchParams.get("IncludeItemTypes");
      const items = type === "Movie" ? [{ Id: "m1", Name: "Matrix", ProductionYear: 1999, ImageTags: { Primary: "t" },
          ProviderIds: { Imdb: "tt0133093", Csfd: "9499-matrix" },
          MediaSources: [{ MediaStreams: [{ Type: "Video", Width: 3840, Height: 2160 }, { Type: "Audio", Language: "ces", Channels: 6 }] }] },
        // a second copy of the same film with another audio track: both tracks belong to the one title
        { Id: "m2", Name: "Matrix", ProductionYear: 1999, ProviderIds: { Imdb: "tt0133093" },
          MediaSources: [{ MediaStreams: [{ Type: "Video", Width: 1920, Height: 1080 }, { Type: "Audio", Language: "eng", Channels: 2 }] }] },
        // two rips in one folder: one item, the listing returns only the default version
        { Id: "m4", Name: "Odyssea", ProductionYear: 2026, ProviderIds: { Imdb: "tt33764258" }, MediaSourceCount: 2,
          MediaSources: [{ MediaStreams: [{ Type: "Audio", Language: "eng", Channels: 6 }] }] }]
        : type === "Series" ? [{ Id: "s1", Name: "Zrádci", ProductionYear: 2024, ProviderIds: { Imdb: "tt33321873" } }]
        : [{ Id: "e1", SeriesId: "s1", DateCreated: "2026-11-11T19:19:13", MediaSources: [{ MediaStreams: [{ Type: "Video", Width: 1920, Height: 1080 }] }] }];
      return j({ Items: items, TotalRecordCount: items.length });
    };
    // unreachable address: the plain-language reason replaces "error sending request"
    env.diagnose = async (u) => `${new URL(u).host} neodpovídá.`;
    const down = await api("POST", "/api/servers/test", { type: "emby", url: "http://10.0.0.1:8096", token: "k" });
    expect(down).toEqual({ ok: false, error: "10.0.0.1:8096 neodpovídá." });
    // away from home: the internal address does not answer, the public one is used
    const away = await api("POST", "/api/servers/test", { type: "emby", url: "http://10.0.0.1:8096", public_url: "http://emby.test", token: "k" });
    expect(away).toMatchObject({ ok: true, info: { name: "Doma", via: "http://emby.test" } });
    env.diagnose = null;
    // Android 17 without the home-network permission: the prompt is shown on test, the error says what to allow
    const asked: boolean[] = [];
    env.localNetwork = async (ask) => { asked.push(ask); return false; };
    const denied = await api("POST", "/api/servers/test", { type: "emby", url: "http://10.0.0.1:8096", token: "k" });
    expect(asked[0]).toBe(true);
    expect(denied.error).toContain("Zařízení v okolí");
    env.localNetwork = null;
    const bad = await api("POST", "/api/servers/test", { type: "emby", url: "http://emby.test", token: "x" });
    expect(bad.ok).toBe(false);
    const ok = await api("POST", "/api/servers/test", { type: "emby", url: "http://emby.test/", token: "k" });
    expect(ok.info.name).toBe("Doma");
    const srv = await api("POST", "/api/servers", { type: "emby", url: "http://emby.test/", public_url: "https://emby.example", token: "k", name: "Doma" });
    expect(srv.token).toBe("••••••••");
    for (let i = 0; i < 100 && !(await env.db.get("SELECT 1 AS x FROM sync_runs WHERE source=? AND finished_at IS NOT NULL", [`server:${srv.id}`])); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const m = (await api("GET", "/api/catalog?q=matrix")).items[0];
    const lib = m.where.find((w: any) => w.kind === "library");
    expect(lib.quality).toBe("UHD");
    expect(lib.audio_langs).toEqual(expect.arrayContaining(["cs", "en"]));        // tracks of both copies
    expect(lib.url).toContain("id=m1");                                           // link to the better copy
    const od = (await api("GET", "/api/catalog?q=odyssea")).items[0].where[0];
    expect(od.audio_langs).toEqual(["en", "cs"]);                                  // both versions of one item
    expect(lib.icon).toBe("https://emby.example/web/favicon.ico");                // the server's own logo
    expect(lib.url).toBe("https://emby.example/web/index.html#!/item?id=m1&serverId=srv1");
    expect(m.ids.csfd).toBe("9499");
    expect(m.ids.csfd_lib).toBe("9499");                                          // the library's ČSFD id is final
    expect(m.poster).toBe("https://emby.example/Items/m1/Images/Primary?maxHeight=360&tag=t");
    const z = (await api("GET", "/api/catalog?q=zradci")).items[0];
    expect(z.where[0].quality).toBe("FHD");
    expect((await api("GET", "/api/settings")).servers[0].token).toBe("••••••••");
    // changing only the address used for links reads the library again (links and posters are stored)
    const runs = async () => (await env.db.get("SELECT COUNT(*) AS n FROM sync_runs WHERE source=?", [`server:${srv.id}`]))!.n;
    const before = await runs();
    await api("POST", "/api/servers", { ...srv, link_mode: "internal" });
    for (let i = 0; i < 100 && (await runs()) === before; i++) await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 100 && manager.running.size; i++) await new Promise((r) => setTimeout(r, 10));
    const m2 = (await api("GET", "/api/catalog?q=matrix")).items[0];
    expect(m2.where.find((w: any) => w.kind === "library").url).toBe("http://emby.test/web/index.html#!/item?id=m1&serverId=srv1");
    expect(srv.id).toMatch(/^[0-9a-f]{8}$/);
    await api("DELETE", `/api/servers/${srv.id}`);
    expect((await api("GET", "/api/catalog?q=zradci")).items.length).toBe(0);
    env.fetch = real;
  });
});

describe("service logos", () => {
  it("finds the logo inside its tile and scales every logo to the same size", async () => {
    const { analyse, placement, TILE, FILL } = await import("../src/logo");
    const img = (w: number, h: number, bg: number[], box: [number, number, number, number], fg: number[]) => {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const inside = x >= box[0] && x < box[0] + box[2] && y >= box[1] && y < box[1] + box[3];
        d.set(inside ? fg : bg, (y * w + x) * 4);
      }
      return d;
    };
    // small wordmark in the middle of a black tile (like a logo with lots of margin)
    const small = analyse(img(100, 100, [0, 0, 0, 255], [35, 45, 30, 10], [229, 9, 20, 255]), 100, 100);
    expect(small.bg).toEqual([0, 0, 0, 255]);
    expect(small.box).toEqual({ x: 35, y: 45, w: 30, h: 10 });
    // logo that nearly fills a blue tile
    const big = analyse(img(100, 100, [17, 60, 207, 255], [5, 20, 90, 60], [255, 255, 255, 255]), 100, 100);
    expect(big.box).toEqual({ x: 5, y: 20, w: 90, h: 60 });
    // both end up equally wide on the output tile
    expect(placement(small.box!).w).toBeCloseTo(TILE * FILL);
    expect(placement(big.box!).w).toBeCloseTo(TILE * FILL);
    // transparent icon: the visible pixels are the logo
    const clear = analyse(img(50, 50, [0, 0, 0, 0], [10, 20, 30, 10], [255, 255, 255, 255]), 50, 50);
    expect(clear.bg[3]).toBe(0);
    expect(clear.box).toEqual({ x: 10, y: 20, w: 30, h: 10 });
  });
});

describe("ČSFD series years", () => {
  it("reads the range from the header's origin line", () => {
    expect(ratings.csfdYears('<div class="origin">USA<span>, </span>(2001–2026)<span>, </span>73 h</div>')).toEqual([2001, 2026]);
    expect(ratings.csfdYears('<div class="origin">USA, (2019– ), 50 min</div>')).toEqual([2019, null]);
    expect(ratings.csfdYears('<div class="origin">USA, <span>(</span><span>2001</span>–<span>2026</span>)</div>')).toEqual([2001, 2026]);
    expect(ratings.csfdYears('<div class="origin">USA, 1999, 136 min</div>')).toBeNull();
    // a film's single year tells two films of one name apart (the stored ČSFD id of another year is dropped)
    expect(ratings.csfdFilmYear('<div class="origin">USA / Velká Británie<span>, </span><span>2026</span><span>, </span>172 min</div>')).toBe(2026);
    expect(ratings.csfdFilmYear('<div class="film-header"></div>')).toBeNull();
  });
});
