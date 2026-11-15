// Normalisation of quality, HDR/audio formats, languages and provider names (port of app/quality.py).

export const QUALITY_ORDER: Record<string, number> = { SD: 1, HD: 2, FHD: 3, QHD: 4, UHD: 5 };

export function bestQuality(...qs: (string | null | undefined)[]): string | null {
  const ok = qs.filter((q): q is string => !!q && q in QUALITY_ORDER);
  return ok.length ? ok.reduce((a, b) => (QUALITY_ORDER[b] > QUALITY_ORDER[a] ? b : a)) : null;
}

/** JustWatch (SD/HD/_4K), Streaming Availability (sd/hd/qhd/uhd), Plex (sd/480/720/1080/4k). */
export function qualityFromLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const s = String(label).trim().toLowerCase().replace(/^_+/, "");
  if (["4k", "uhd", "2160", "2160p", "8k"].includes(s)) return "UHD";
  if (["qhd", "1440", "1440p"].includes(s)) return "QHD";
  if (["1080", "1080p", "fhd"].includes(s)) return "FHD";
  if (["hd", "720", "720p"].includes(s)) return "HD";
  if (["sd", "480", "576", "480p", "576p"].includes(s)) return "SD";
  return null;
}

const VIDEO_PATTERNS: [string, RegExp][] = [
  ["DV", /dolby\s*vision|\bdovi\b|\bdv\b|dolbyvision/],
  ["HDR10+", /hdr\s*10\s*(\+|plus)/],
  ["HDR10", /hdr\s*10(?!\s*(\+|plus))/],
  ["HLG", /\bhlg\b|hyperloggamma|arib-std-b67/],
  ["HDR", /\bhdr\b|smpte2084|\bpq\b/],
];
const AUDIO_PATTERNS: [string, RegExp][] = [
  ["Atmos", /atmos/],
  ["DTS:X", /dts[\s:-]*x\b|dtsx/],
  ["TrueHD", /truehd/],
  ["DTS-HD MA", /dts[\s-]*hd[\s-]*ma|\bdts-hd\b|\bma\b/],
  ["DTS", /\bdts\b|\bdca\b/],
  ["DD+", /\beac3\b|e-ac-3|dolby digital\s*\+|dolby digital plus|\bdd\+|\bddp\b/],
  ["DD", /\bac3\b|\bac-3\b|dolby digital(?!\s*\+| plus)/],
  ["FLAC", /\bflac\b/],
];
const VIDEO_CODECS: Record<string, string> = { hevc: "HEVC", h265: "HEVC", h264: "H.264", avc: "H.264", av1: "AV1", vp9: "VP9" };

export function videoTags(texts: (string | null | undefined)[], codec?: string | null): string[] {
  const blob = texts.filter(Boolean).join(" ").toLowerCase().replace(/_/g, " ");
  let tags = VIDEO_PATTERNS.filter(([, re]) => re.test(blob)).map(([t]) => t);
  if (tags.includes("HDR") && tags.length > 1) tags = tags.filter((t) => t !== "HDR");
  const c = VIDEO_CODECS[(codec || "").toLowerCase()];
  if (c) tags.push(c);
  return tags;
}

export function audioTags(texts: (string | null | undefined)[], codec?: string | null, channels?: number | null): string[] {
  const blob = [...texts, codec].filter(Boolean).join(" ").toLowerCase().replace(/_/g, " ");
  let tags = AUDIO_PATTERNS.filter(([, re]) => re.test(blob)).map(([t]) => t);
  for (const [a, b] of [["DTS-HD MA", "DTS"], ["DTS:X", "DTS"], ["DD+", "DD"]]) {
    if (tags.includes(a) && tags.includes(b)) tags = tags.filter((t) => t !== b);
  }
  if (channels) tags.push(({ 8: "7.1", 7: "6.1", 6: "5.1", 2: "2.0", 1: "1.0" } as Record<number, string>)[channels] || `${channels}ch`);
  return tags;
}

/** JustWatch videoTechnology / audioTechnology enums, e.g. DOLBY_VISION, DOLBY_ATMOS. */
export function justwatchTech(values: string[] | null | undefined, kind: "video" | "audio"): string[] {
  const out: string[] = [];
  for (const v of values || []) {
    let mapped = kind === "video" ? videoTags([v]) : audioTags([v]);
    if (!mapped.length) {
      const special: Record<string, string> = { _5_POINT_1: "5.1", "5_POINT_1": "5.1", _7_POINT_1: "7.1", "7_POINT_1": "7.1" };
      const s = v.replace(/^_+|_+$/g, "").toUpperCase();
      mapped = [special[v.toUpperCase()] || s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase())];
    }
    for (const m of mapped) if (!out.includes(m)) out.push(m);
  }
  return out;
}

export function mergeTags(...lists: (string[] | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const l of lists) for (const t of l || []) if (t && !out.includes(t)) out.push(t);
  return out;
}

const LANG3: Record<string, string> = {
  cze: "cs", ces: "cs", slo: "sk", slk: "sk", eng: "en", ger: "de", deu: "de", fre: "fr", fra: "fr", spa: "es",
  ita: "it", pol: "pl", hun: "hu", rus: "ru", ukr: "uk", jpn: "ja", kor: "ko", chi: "zh", zho: "zh", por: "pt",
  dut: "nl", nld: "nl", swe: "sv", nor: "no", nob: "no", dan: "da", fin: "fi", tur: "tr", gre: "el", ell: "el",
  heb: "he", ara: "ar", hin: "hi", tha: "th", rum: "ro", ron: "ro", bul: "bg", hrv: "hr", srp: "sr", slv: "sl",
  vie: "vi", ind: "id",
};

export function lang(code: string | null | undefined): string | null {
  if (!code) return null;
  const c = code.trim().toLowerCase().replace(/_/g, "-").split("-")[0];
  if (["und", "zxx", "mis", "mul", ""].includes(c)) return null;
  return c.length === 3 ? LANG3[c] || c : c;
}

export function langs(codes: string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const c of codes || []) {
    const l = lang(c);
    if (l && !out.includes(l)) out.push(l);
  }
  return out;
}

const PROVIDER_ALIASES: Record<string, string> = {
  max: "hbomax", hbo: "hbomax", hbomax: "hbomax", disney: "disneyplus", disneyplus: "disneyplus", dnp: "disneyplus",
  netflix: "netflix", nfx: "netflix", prime: "primevideo", primevideo: "primevideo", amazonprimevideo: "primevideo",
  amazonprime: "primevideo", apple: "appletv", appletv: "appletv", appletvplus: "appletv", atp: "appletv",
  skyshowtime: "skyshowtime", oneplay: "oneplay", paramount: "paramountplus", paramountplus: "paramountplus",
};

export function stripAccents(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "");
}

export function providerKey(nameOrId: string): string {
  const s = stripAccents(nameOrId || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return PROVIDER_ALIASES[s] || s;
}

export function norm(s: string | null | undefined): string {
  if (!s) return "";
  return stripAccents(s).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
