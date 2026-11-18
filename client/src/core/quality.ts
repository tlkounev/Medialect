// Normalisation of quality, HDR/audio formats, languages and provider names (port of app/quality.py).

export const QUALITY_ORDER: Record<string, number> = { SD: 1, HD: 2, FHD: 3, QHD: 4, UHD: 5 };

export function bestQuality(...qs: (string | null | undefined)[]): string | null {
  const ok = qs.filter((q): q is string => !!q && q in QUALITY_ORDER);
  return ok.length ? ok.reduce((a, b) => (QUALITY_ORDER[b] > QUALITY_ORDER[a] ? b : a)) : null;
}

export function qualityFromDims(width?: number | null, height?: number | null): string | null {
  const w = width || 0, h = height || 0;
  if (!w && !h) return null;
  if (w >= 3200 || h >= 1800) return "UHD";
  if (w >= 2200 || h >= 1300) return "QHD";
  if (w >= 1800 || h >= 1000) return "FHD";
  if (w >= 1200 || h >= 700) return "HD";
  return "SD";
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

const LANG3: Record<string, string> = {"afr": "af", "alb": "sq", "amh": "am", "ara": "ar", "arm": "hy", "aze": "az", "baq": "eu", "bel": "be", "ben": "bn", "bos": "bs", "bul": "bg", "bur": "my", "cat": "ca", "ces": "cs", "chi": "zh", "cmn": "zh", "cym": "cy", "cze": "cs", "dan": "da", "deu": "de", "dut": "nl", "ell": "el", "eng": "en", "est": "et", "eus": "eu", "fao": "fo", "fas": "fa", "fil": "tl", "fin": "fi", "fra": "fr", "fre": "fr", "geo": "ka", "ger": "de", "gla": "gd", "gle": "ga", "glg": "gl", "gre": "el", "gsw": "de", "guj": "gu", "heb": "he", "hin": "hi", "hrv": "hr", "hun": "hu", "hye": "hy", "ice": "is", "ind": "id", "isl": "is", "ita": "it", "jpn": "ja", "kan": "kn", "kat": "ka", "kaz": "kk", "khm": "km", "kor": "ko", "lao": "lo", "lat": "la", "lav": "lv", "lit": "lt", "ltz": "lb", "mac": "mk", "mal": "ml", "mar": "mr", "may": "ms", "mkd": "mk", "mlt": "mt", "mon": "mn", "msa": "ms", "mya": "my", "nep": "ne", "nld": "nl", "nno": "no", "nob": "no", "nor": "no", "pan": "pa", "per": "fa", "pol": "pl", "por": "pt", "ron": "ro", "rum": "ro", "rus": "ru", "sin": "si", "slk": "sk", "slo": "sk", "slv": "sl", "sme": "se", "som": "so", "spa": "es", "sqi": "sq", "srp": "sr", "swa": "sw", "swe": "sv", "tam": "ta", "tel": "te", "tgl": "tl", "tha": "th", "tur": "tr", "ukr": "uk", "urd": "ur", "uzb": "uz", "vie": "vi", "wel": "cy", "xho": "xh", "yid": "yi", "yue": "zh", "zho": "zh", "zul": "zu"};
const LANG2_ALIAS: Record<string, string> = {"fil": "tl", "in": "id", "iw": "he", "ji": "yi", "jw": "jv", "mo": "ro", "nb": "no", "nn": "no", "sh": "sr"};
const LANG_NAMES: Record<string, string> = {"bahasa indonesia": "id", "bahasa melayu": "ms", "tieng viet": "vi", "afrikaans": "af", "albanian": "sq", "amharic": "am", "arabic": "ar", "armenian": "hy", "azerbaijani": "az", "azerbaycan": "az", "bangla": "bn", "basque": "eu", "belarusian": "be", "bengali": "bn", "bengali bangla": "bn", "bokmal": "no", "bosanski": "bs", "bosnian": "bs", "brazilian portuguese": "pt", "bulgarian": "bg", "burmese": "my", "canadian french": "fr", "cantonese": "zh", "castellano": "es", "castilian": "es", "catala": "ca", "catalan": "ca", "cesky": "cs", "cestina": "cs", "chinese": "zh", "chinese mandarin cantonese": "zh", "chinese simplified": "zh", "chinese traditional": "zh", "croatian": "hr", "cymraeg": "cy", "czech": "cs", "danish": "da", "dansk": "da", "deutsch": "de", "dutch": "nl", "dutch flemish": "nl", "eesti": "et", "english": "en", "espanol": "es", "estonian": "et", "european spanish": "es", "euskara": "eu", "faroese": "fo", "farsi": "fa", "filipino": "tl", "finnish": "fi", "flemish": "nl", "francais": "fr", "french": "fr", "gaeilge": "ga", "gaelic": "gd", "gaelic scottish gaelic": "gd", "galego": "gl", "galician": "gl", "georgian": "ka", "german": "de", "greek": "el", "gujarati": "gu", "hebrew": "he", "hindi": "hi", "hrvatski": "hr", "hungarian": "hu", "icelandic": "is", "indonesia": "id", "indonesian": "id", "irish": "ga", "islenska": "is", "italian": "it", "italiano": "it", "japanese": "ja", "kannada": "kn", "kazakh": "kk", "khmer": "km", "kiswahili": "sw", "korean": "ko", "lao": "lo", "latin": "la", "latin american spanish": "es", "latina": "la", "latvian": "lv", "latviesu": "lv", "lietuviu": "lt", "lithuanian": "lt", "luxembourgish": "lb", "macedonian": "mk", "magyar": "hu", "malay": "ms", "malayalam": "ml", "maltese": "mt", "mandarin": "zh", "marathi": "mr", "melayu": "ms", "moldavian": "ro", "mongolian": "mn", "nederlands": "nl", "nepali": "ne", "norsk": "no", "northern": "se", "northern sami sami": "se", "norwegian": "no", "norwegian bokmal nynorsk": "no", "nynorsk": "no", "ozbek": "uz", "panjabi": "pa", "persian": "fa", "persian farsi": "fa", "polish": "pl", "polski": "pl", "portugues": "pt", "portuguese": "pt", "portuguese brazilian": "pt", "punjabi": "pa", "punjabi panjabi": "pa", "romana": "ro", "romanian": "ro", "romanian moldavian": "ro", "russian": "ru", "russkij": "ru", "sami": "se", "scottish": "gd", "serbian": "sr", "shqip": "sq", "simplified chinese": "zh", "sinhala": "si", "sinhala sinhalese": "si", "sinhalese": "si", "slovak": "sk", "slovencina": "sk", "slovene": "sl", "slovenian": "sl", "slovenian slovene": "sl", "slovenscina": "sl", "slovensky": "sk", "somali": "so", "spanish": "es", "spanish castilian": "es", "spanish latin american": "es", "srpski": "sr", "suomi": "fi", "svenska": "sv", "swahili": "sw", "swedish": "sv", "tagalog": "tl", "tagalog filipino": "tl", "tamil": "ta", "telugu": "te", "thai": "th", "traditional chinese": "zh", "turkce": "tr", "turkish": "tr", "ukrainian": "uk", "urdu": "ur", "uzbek": "uz", "vietnamese": "vi", "vlaams": "nl", "welsh": "cy", "xhosa": "xh", "yiddish": "yi", "zulu": "zu", "ελληνικά": "el", "беларуская": "be", "български": "bg", "македонски": "mk", "русский": "ru", "српски": "sr", "українська": "uk", "қазақ": "kk", "հայերեն": "hy", "עברית": "he", "اردو": "ur", "العربية": "ar", "فارسی": "fa", "हिन्दी": "hi", "বাংলা": "bn", "தமிழ்": "ta", "తెలుగు": "te", "ไทย": "th", "ქართული": "ka", "中文": "zh", "日本語": "ja", "普通话": "zh", "粤语": "zh", "한국어": "ko"};

/** One ISO 639-1 code for a language, whatever form the source uses: "cs", "cze", "ces", "cs-CZ",
 *  "Czech", "Čeština", "Czech (Forced)" all give "cs". Unknown names are dropped. */
export function lang(code: string | null | undefined): string | null {
  if (!code) return null;
  const t = code.trim().toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/[([].*?[)\]]/g, " ").replace(/_/g, "-").replace(/^[\s\-.,]+|[\s\-.,]+$/g, "");
  if (!t) return null;
  if (LANG_NAMES[t]) return LANG_NAMES[t];
  const c = t.split(/[-\s]/)[0];
  if (["und", "zxx", "mis", "mul", "unk", "unknown", "original", "other", ""].includes(c)) return null;
  if (/^[a-z]{2}$/.test(c)) return LANG2_ALIAS[c] || c;
  if (/^[a-z]{3}$/.test(c)) return LANG3[c] || LANG2_ALIAS[c] || c;
  return LANG_NAMES[c] || null;
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
