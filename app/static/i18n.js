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
const langName = (code) => displayName(code, "language");
const regionName = (code) => displayName(code, "region");

/* Flags next to language and country names (emoji; Windows gets them from the bundled Twemoji font). */
const LANG_FLAG = {
  cs: "CZ", sk: "SK", en: "GB", de: "DE", pl: "PL", hu: "HU", fr: "FR", es: "ES", it: "IT", pt: "PT", nl: "NL",
  sv: "SE", da: "DK", nb: "NO", no: "NO", nn: "NO", fi: "FI", uk: "UA", ru: "RU", ro: "RO", hr: "HR", sl: "SI",
  sr: "RS", bs: "BA", mk: "MK", bg: "BG", el: "GR", tr: "TR", et: "EE", lv: "LV", lt: "LT", is: "IS", ga: "IE",
  ja: "JP", ko: "KR", zh: "CN", ar: "SA", hi: "IN", ta: "IN", te: "IN", bn: "BD", ur: "PK", fa: "IR", he: "IL",
  id: "ID", ms: "MY", th: "TH", vi: "VN", tl: "PH", fil: "PH", ca: "AD", eu: "ES", gl: "ES", sq: "AL", ka: "GE",
  hy: "AM", az: "AZ", kk: "KZ", be: "BY", af: "ZA",
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
