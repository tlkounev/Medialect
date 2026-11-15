// Against the real services; runs in CI (job "live") with LIVE=1, never blocks a release.
import { describe, expect, it } from "vitest";
import { env } from "../src/core/env";
import { listProviders, popularPage } from "../src/core/justwatch";

describe.runIf(process.env.LIVE === "1")("live services", () => {
  it("JustWatch: providers and one page of a catalogue", async () => {
    env.sleep = async () => {};
    const provs = await listProviders("CZ");
    console.log("CZ providers:", provs.map((p) => `${p.short_name}=${p.name}`).join(", "));
    expect(provs.some((p) => p.short_name === "nfx")).toBe(true);
    const nodes = await popularPage("CZ", "cs", 5, 0, "nfx", 2020, 2024, "MOVIE");
    console.log(nodes.map((n) => `${n.content.title} (${n.content.originalReleaseYear}) offers=${n.offers.length}`).join("\n"));
    expect(nodes.length).toBe(5);
    expect(nodes[0].offers.some((o: any) => o.package.shortName === "nfx")).toBe(true);
  });

  it("IMDb dataset and TVmaze answer", async () => {
    const r = await fetch("https://datasets.imdbws.com/title.ratings.tsv.gz", { method: "HEAD" });
    expect(r.ok).toBe(true);
    const t = await (await fetch("https://api.tvmaze.com/lookup/shows?imdb=tt7366338")).json();
    expect(t.rating.average).toBeGreaterThan(0);
  });
});
