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
      const type = u.searchParams.get("IncludeItemTypes");
      const items = type === "Movie" ? [{ Id: "m1", Name: "Matrix", ProductionYear: 1999, ImageTags: { Primary: "t" },
          ProviderIds: { Imdb: "tt0133093", Csfd: "9499-matrix" },
          MediaSources: [{ MediaStreams: [{ Type: "Video", Width: 3840, Height: 2160 }, { Type: "Audio", Language: "ces", Channels: 6 }] }] }]
        : type === "Series" ? [{ Id: "s1", Name: "Zrádci", ProductionYear: 2024, ProviderIds: { Imdb: "tt33321873" } }]
        : [{ Id: "e1", SeriesId: "s1", DateCreated: "2026-11-11T19:19:13", MediaSources: [{ MediaStreams: [{ Type: "Video", Width: 1920, Height: 1080 }] }] }];
      return j({ Items: items, TotalRecordCount: items.length });
    };
    // unreachable address: the plain-language reason replaces "error sending request"
    env.diagnose = async (u) => `${new URL(u).host} neodpovídá.`;
    const down = await api("POST", "/api/servers/test", { type: "emby", url: "http://10.0.0.1:8096", token: "k" });
    expect(down).toEqual({ ok: false, error: "10.0.0.1:8096 neodpovídá." });
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
    expect(lib.icon).toBe("https://emby.example/web/favicon.ico");                // the server's own logo
    expect(lib.url).toBe("https://emby.example/web/index.html#!/item?id=m1&serverId=srv1");
    expect(m.ids.csfd).toBe("9499");
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
