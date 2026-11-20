"use strict";
/* UI translations. Texts live in /static/i18n/<code>.json; Czech is the complete fallback. */
const UI_LANGS = [
  ["cs", "Čeština"], ["sk", "Slovenčina"], ["en", "English"], ["zh", "中文"], ["hi", "हिन्दी"],
  ["es", "Español"], ["ar", "العربية"], ["fr", "Français"], ["pt", "Português"], ["ru", "Русский"],
  ["id", "Bahasa Indonesia"], ["de", "Deutsch"], ["ja", "日本語"], ["vi", "Tiếng Việt"], ["tr", "Türkçe"],
  ["ko", "한국어"], ["it", "Italiano"], ["pl", "Polski"], ["uk", "Українська"], ["nl", "Nederlands"],
  ["ro", "Română"], ["hu", "Magyar"], ["sv", "Svenska"], ["da", "Dansk"], ["nb", "Norsk bokmål"],
  ["fi", "Suomi"], ["hr", "Hrvatski"], ["sl", "Slovenščina"],
];
const RTL_LANGS = ["ar"];
const LANG_KEY = "medialect.lang";
let uiLang = "cs", STR = {}, FALLBACK = {};

function pickLang() {
  try { const saved = localStorage.getItem(LANG_KEY); if (saved && UI_LANGS.some(([c]) => c === saved)) return saved; } catch (_) { /* private mode */ }
  for (const l of navigator.languages || [navigator.language || "cs"]) {
    const code = String(l).toLowerCase().split("-")[0].replace(/^no$|^nn$/, "nb");
    if (UI_LANGS.some(([c]) => c === code)) return code;
  }
  return "cs";
}

async function fetchLang(code, version) {
  const r = await fetch(`/static/i18n/${code}.json?v=${encodeURIComponent(version || "")}`);
  return r.ok ? r.json() : {};
}

async function initI18n(version, code = pickLang()) {
  if (!Object.keys(FALLBACK).length) FALLBACK = await fetchLang("cs", version);
  uiLang = code;
  STR = code === "cs" ? FALLBACK : await fetchLang(code, version);
  document.documentElement.lang = code;
  document.documentElement.dir = RTL_LANGS.includes(code) ? "rtl" : "ltr";
  try { localStorage.setItem(LANG_KEY, code); } catch (_) { /* private mode */ }
}

function t(key, vars) {
  let s = STR[key] ?? FALLBACK[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return s;
}

function applyI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  root.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
}

/* language / country names in the UI language */
function displayName(code, type) {
  try {
    const n = new Intl.DisplayNames([uiLang], { type }).of(type === "region" ? code.toUpperCase() : code);
    return n && n.toLowerCase() !== code.toLowerCase() ? n : code;
  } catch (_) { return code; }
}
// language groups of ISO 639-2 that the browsers do not name (Apocalypto is in a Mayan language: "myn")
const LANG_GROUPS = {
  myn: { cs: "mayské jazyky", sk: "mayské jazyky", de: "Maya-Sprachen", en: "Mayan languages" },
  sgn: { cs: "znakové jazyky", sk: "posunkové jazyky", de: "Gebärdensprachen", en: "Sign languages" },
  ber: { cs: "berberské jazyky", sk: "berberské jazyky", de: "Berbersprachen", en: "Berber languages" },
  smi: { cs: "sámské jazyky", sk: "saamské jazyky", de: "Samische Sprachen", en: "Sami languages" },
  nai: { cs: "jazyky severoamerických indiánů", sk: "jazyky severoamerických Indiánov", de: "Nordamerikanische Indianersprachen", en: "North American Indian languages" },
  sai: { cs: "jazyky jihoamerických indiánů", sk: "jazyky juhoamerických Indiánov", de: "Südamerikanische Indianersprachen", en: "South American Indian languages" },
  sla: { cs: "slovanské jazyky", sk: "slovanské jazyky", de: "Slawische Sprachen", en: "Slavic languages" },
  art: { cs: "umělé jazyky", sk: "umelé jazyky", de: "Kunstsprachen", en: "Constructed languages" },
};
const langName = (code) => {
  const g = LANG_GROUPS[(code || "").toLowerCase()];
  return g ? (g[uiLang] || g[uiLang.split("-")[0]] || g.en) : displayName(code, "language");
};
const regionName = (code) => displayName(code, "region");

/* Flags next to language and country names (emoji; Windows gets them from the bundled Twemoji font). */
// ISO 639 language -> the country where it is mainly spoken; constructed languages (eo, ia, io, vo) have none
const LANG_FLAG = {
  aa: "ET", ab: "GE", ae: "IR", af: "ZA", ak: "GH", am: "ET", an: "ES", ar: "SA", as: "IN", av: "RU", ay: "BO",
  az: "AZ", ba: "RU", be: "BY", bg: "BG", bh: "IN", bi: "VU", bm: "ML", bn: "BD", bo: "CN", br: "FR", bs: "BA",
  ca: "AD", ce: "RU", ch: "GU", co: "FR", cr: "CA", cs: "CZ", cu: "BG", cv: "RU", cy: "GB", da: "DK", de: "DE",
  dv: "MV", dz: "BT", ee: "GH", el: "GR", en: "GB", es: "ES", et: "EE", eu: "ES", fa: "IR", ff: "SN", fi: "FI",
  fj: "FJ", fo: "FO", fr: "FR", fy: "NL", ga: "IE", gd: "GB", gl: "ES", gn: "PY", gu: "IN", gv: "IM", ha: "NG",
  he: "IL", hi: "IN", ho: "PG", hr: "HR", ht: "HT", hu: "HU", hy: "AM", hz: "NA", id: "ID", ig: "NG", ii: "CN",
  ik: "US", is: "IS", it: "IT", iu: "CA", ja: "JP", jv: "ID", ka: "GE", kg: "CD", ki: "KE", kj: "NA", kk: "KZ",
  kl: "GL", km: "KH", kn: "IN", ko: "KR", kr: "NG", ks: "IN", ku: "IQ", kv: "RU", kw: "GB", ky: "KG", la: "VA",
  lb: "LU", lg: "UG", li: "NL", ln: "CD", lo: "LA", lt: "LT", lu: "CD", lv: "LV", mg: "MG", mh: "MH", mi: "NZ",
  mk: "MK", ml: "IN", mn: "MN", mr: "IN", ms: "MY", mt: "MT", my: "MM", na: "NR", nb: "NO", nd: "ZW", ne: "NP",
  ng: "NA", nl: "NL", nn: "NO", no: "NO", nr: "ZA", nv: "US", ny: "MW", oc: "FR", oj: "CA", om: "ET", or: "IN",
  os: "RU", pa: "IN", pi: "IN", pl: "PL", ps: "AF", pt: "PT", qu: "PE", rm: "CH", rn: "BI", ro: "RO", ru: "RU",
  rw: "RW", sa: "IN", sc: "IT", sd: "PK", se: "NO", sg: "CF", si: "LK", sk: "SK", sl: "SI", sm: "WS", sn: "ZW",
  so: "SO", sq: "AL", sr: "RS", ss: "SZ", st: "LS", su: "ID", sv: "SE", sw: "TZ", ta: "IN", te: "IN", tg: "TJ",
  th: "TH", ti: "ER", tk: "TM", tl: "PH", tn: "BW", to: "TO", tr: "TR", ts: "ZA", tt: "RU", tw: "GH", ty: "PF",
  ug: "CN", uk: "UA", ur: "PK", uz: "UZ", ve: "ZA", vi: "VN", wa: "BE", wo: "SN", xh: "ZA", yo: "NG", za: "CN",
  zh: "CN", zu: "ZA", fil: "PH", ceb: "PH", haw: "US", chr: "US", sco: "GB", nds: "DE", gsw: "CH", ast: "ES",
  yue: "HK", cmn: "CN", hmn: "LA", kok: "IN", mai: "IN", mni: "IN", sat: "IN", doi: "IN", brx: "IN", bho: "IN",
  tet: "TL", mos: "BF", myn: "GT", ber: "MA", smi: "NO",
};
function flagEmoji(cc) {
  if (!/^[A-Za-z]{2}$/.test(cc || "")) return "";
  return String.fromCodePoint(...[...cc.toUpperCase()].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}
const langFlag = (code) => flagEmoji(LANG_FLAG[(code || "").toLowerCase()]);
const langLabel = (code) => `${langFlag(code)} ${langName(code)}`.trim();
const regionLabel = (cc) => `${flagEmoji(cc)} ${regionName(cc)}`.trim();
const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString(uiLang); } catch (_) { return iso.slice(0, 10); } };
const fmtNum = (n) => { try { return Number(n).toLocaleString(uiLang); } catch (_) { return String(n); } };
