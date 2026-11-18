"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SA_CATALOGS = ["netflix", "prime", "disney", "hbo", "apple", "skyshowtime", "paramount", "curiosity", "crunchyroll", "mubi", "zee5"];
const COUNTRIES = ["CZ", "SK", "PL", "DE", "AT", "CH", "HU", "SI", "HR", "RS", "RO", "BG", "GR", "TR", "UA", "EE", "LV", "LT",
  "GB", "IE", "FR", "BE", "NL", "LU", "ES", "PT", "IT", "SE", "NO", "DK", "FI", "IS", "US", "CA", "MX", "BR", "AR",
  "AU", "NZ", "JP", "KR", "IN", "ZA", "TW", "HK", "SG", "MY", "TH", "PH", "ID", "AE", "SA", "EG"];
const TITLE_LANGS = ["cs", "sk", "en", "de", "pl", "hu", "fr", "es", "it", "pt", "nl", "sv", "da", "no", "fi", "uk", "ru",
  "ro", "hr", "sl", "sr", "bg", "el", "tr", "et", "lv", "lt", "ja", "ko", "zh", "ar", "hi", "id", "vi"];
const RATING_LABEL = { csfd: "ČSFD", imdb: "IMDb", rottentomatoes: "RT", rottentomatoes_audience: "RT 👥", metacritic: "Metacritic", metacritic_user: "MC 👥", letterboxd: "Letterboxd", tmdb: "TMDB", tvmaze: "TVmaze", trakt: "Trakt", mdblist: "MDBList", rogerebert: "Ebert" };
const QUALITY_LABEL = { UHD: "4K", QHD: "1440p", FHD: "1080p", HD: "720p", SD: "SD" };

let isAdmin = false, appVersion = "";

async function api(path, opts = {}) {
  const init = { credentials: "same-origin", ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } };
  if (init.body && typeof init.body !== "string") init.body = JSON.stringify(init.body);
  const r = await fetch(path, init);
  if (r.status === 401 && !path.startsWith("/api/auth/")) { setAdmin(false); throw new Error(t("err.unauth")); }
  const data = r.headers.get("content-type")?.includes("json") ? await r.json() : null;
  if (!r.ok) throw new Error(data?.detail || `HTTP ${r.status}`);
  return data;
}

/* ---------- start ---------- */
let authMode = "login";
async function boot() {
  const st = await api("/api/auth/state");
  appVersion = st.version;
  await initI18n(appVersion);
  buildLangPicker();
  applyI18n();
  authMode = st.configured ? "login" : "setup";
  if (st.local) {
    // desktop/mobile app: no login, "Administrace" is just the settings
    document.body.classList.add("local");
  }
  loadVersion(true);
  setAdmin(st.logged_in, false);
  let start = location.hash.slice(1) || "catalog";
  if (st.local) { try { if ((await api("/api/onboarding")).pending) start = "admin"; } catch (_) { /* ignore */ } }
  openTab(start);
  pollProgress();
  loadDataBy();
}

function buildLangPicker() {
  const sel = $("#uiLang");
  sel.innerHTML = UI_LANGS.map(([c, n]) => `<option value="${c}">${esc(n)}</option>`).join("");
  sel.value = uiLang;
  // the bar shows only the flag; the names are in the list it opens
  $("#langBtn").textContent = langFlag(uiLang) || uiLang.toUpperCase();
  $("#langList").innerHTML = UI_LANGS.map(([c, n]) => `<button type="button" role="menuitem" data-lang="${c}" class="${c === uiLang ? "on" : ""}">
    <span class="flag">${langFlag(c)}</span><span>${esc(n)}</span></button>`).join("");
}
function langMenu(open) {
  $("#langList").classList.toggle("hidden", !open);
  $("#langBtn").setAttribute("aria-expanded", String(open));
  if (open) ($("#langList button.on") || $("#langList button"))?.focus();
}
$("#langBtn").addEventListener("click", (e) => { e.stopPropagation(); langMenu($("#langList").classList.contains("hidden")); });
$("#langList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-lang]");
  if (!b) return;
  langMenu(false);
  const sel = $("#uiLang");
  if (sel.value === b.dataset.lang) return;
  sel.value = b.dataset.lang;
  sel.dispatchEvent(new Event("change"));
});
document.addEventListener("click", (e) => { if (!e.target.closest?.(".lang-menu")) langMenu(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#langList").classList.contains("hidden")) { langMenu(false); $("#langBtn").focus(); } });
$("#uiLang").addEventListener("change", async (e) => {
  await initI18n(appVersion, e.target.value);
  applyI18n();
  buildLangPicker();
  renderLogin();
  loadVersion();
  facetsLoaded = false;   // option labels are translated: rebuild them, keep the choice
  openTab(currentTab);
  pollProgress();
  loadDataBy();
});

/* ---------- admin login ---------- */
function setAdmin(logged, refresh = true) {
  isAdmin = logged;
  $("#logout").classList.toggle("hidden", !logged);
  $("#adminPanel").classList.toggle("hidden", !logged);
  if (!logged) $("#wizard").classList.add("hidden");
  $("#adminLogin").classList.toggle("hidden", logged);
  if (!logged) { $("#syncBadge").classList.add("hidden"); renderLogin(); }
  if (refresh && !$("#tab-admin").classList.contains("hidden")) openTab("admin");
}
function renderLogin() {
  const setup = authMode === "setup";
  $("#authHint").textContent = setup ? t("login.setupHint") : t("login.hint");
  $("#authPass2").classList.toggle("hidden", !setup);
  $("#authPass2").required = setup;
  $("#authBtn").textContent = setup ? t("login.setupBtn") : t("login.btn");
}
$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#authErr").textContent = "";
  const password = $("#authPass").value;
  if (authMode === "setup" && password !== $("#authPass2").value) { $("#authErr").textContent = t("login.mismatch"); return; }
  try {
    await api(authMode === "setup" ? "/api/auth/setup" : "/api/auth/login", { method: "POST", body: { password } });
    $("#authPass").value = $("#authPass2").value = "";
    authMode = "login";
    setAdmin(true);
    pollProgress();
  } catch (err) { $("#authErr").textContent = err.message; }
});
$("#logout").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  setAdmin(false);
  openTab("catalog");
});

/* ---------- version: green = up to date, red = update available, grey = cannot check ---------- */
async function loadVersion(refresh = false) {
  const el = $("#appVersion");
  try {
    const v = await api(`/api/version${refresh ? "?refresh=1" : ""}`);
    el.textContent = v.current === "dev" ? "dev" : `v${v.current}`;
    el.className = `version v-${v.state}`;
    el.href = v.url;
    el.title = v.state === "current" ? t("ver.current") : v.state === "update" ? t("ver.update", { v: v.latest }) : t("ver.unknown");
  } catch (_) { el.className = "version v-unknown"; }
}
setInterval(() => loadVersion(), 5 * 60 * 1000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") loadVersion(true); });

/* ---------- tabs ---------- */
let statusTimer = null, adminSub = "settings", lastBadge = [[], 0];
let currentTab = "catalog";
function openTab(name) {
  if (!$(`#tab-${name}`)) name = "catalog";
  currentTab = name;
  $("#openSettings").classList.toggle("on", name === "admin");
  $$("main > section").forEach((s) => s.classList.toggle("hidden", s.id !== `tab-${name}`));
  history.replaceState(history.state, "", `#${name}`);
  clearInterval(statusTimer);
  updateSyncBadge(...lastBadge);
  if (name === "catalog") loadFacets().catch(() => {}).then(() => loadCatalog());
  if (name === "admin") {
    if (isAdmin) openAdmin(); else $("#authPass").focus();
  }
}
async function openAdmin() {
  let pending = false;
  try { pending = (await api("/api/onboarding")).pending; } catch (_) { /* older server */ }
  $("#wizard").classList.toggle("hidden", !pending);
  $("#adminPanel").classList.toggle("hidden", pending);
  if (pending) startWizard(); else openSub(adminSub);
}
/* Help texts in the settings stay hidden behind a small "?" next to their label (the ratings keep theirs:
   they say what each source costs). Safe to call again: a text gets its button once. */
const HELP = "small[data-i18n], .section-hint, .box-head > p.muted, .box-body > p.muted[data-i18n]";
function helpToggles(root) {
  for (const el of root.querySelectorAll(HELP)) {
    if (el.dataset.help || el.closest(".keep-help")) continue;
    el.dataset.help = "1";
    el.classList.add("help", "hidden");
    const host = el.closest("label, .field")?.querySelector(":scope > span")
      || (el.matches(".section-hint") ? el.closest("fieldset, [data-step]")?.querySelector("legend, h3") : null)
      || el.closest(".settings-box")?.querySelector(".box-head h2")
      || el.previousElementSibling;
    if (!host) { el.classList.remove("hidden"); continue; }
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "help-btn"; btn.textContent = "?";
    btn.setAttribute("aria-expanded", "false");
    btn.title = t("ui.help"); btn.setAttribute("aria-label", t("ui.help"));
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();          // inside a <label>: do not tick its checkbox
      const open = el.classList.toggle("hidden") === false;
      btn.setAttribute("aria-expanded", String(open));
    });
    if (host.dataset.i18n) {                          // keep the translated text in its own span, so a language
      const label = document.createElement("span");   // switch does not wipe the button
      label.dataset.i18n = host.dataset.i18n; label.textContent = host.textContent;
      delete host.dataset.i18n;
      host.replaceChildren(label);
    }
    host.append(btn);
  }
}
helpToggles($("#adminPanel"));
function openSub(name) {
  adminSub = name;
  clearInterval(statusTimer);
  $$(".subnav button[data-sub]").forEach((b) => b.classList.toggle("active", b.dataset.sub === name));
  for (const sub of ["settings", "updates", "sync"]) $(`#sub-${sub}`)?.classList.toggle("hidden", name !== sub);
  if (name === "sync") { loadStatus(); statusTimer = setInterval(loadStatus, 5000); }
  if (name === "settings") loadSettings();
}
/* Settings get their own history entry, so the system back gesture (Android, browser) returns to the
   catalogue instead of closing the app; going back by a button uses the same entry. */
function goTo(name) {
  if (name === currentTab) return;
  if (name === "catalog" && history.state?.pushed) { history.back(); return; }   // popstate opens it
  if (currentTab === "catalog") history.pushState({ pushed: true }, "", `#${name}`);
  openTab(name);
}
addEventListener("popstate", () => openTab(location.hash.slice(1) || "catalog"));
// the gear always opens the settings page (also from Updates or Synchronisation)
$("#openSettings").addEventListener("click", () => {
  adminSub = "settings";
  if (currentTab === "admin") openSub("settings"); else goTo("admin");
});
$("#home").addEventListener("click", (e) => { if (!e.target.closest("a")) goTo("catalog"); });
$("#home").addEventListener("keydown", (e) => { if (e.key === "Enter") goTo("catalog"); });
$$(".subnav [data-back]").forEach((b) => b.addEventListener("click", () => goTo("catalog")));
$$(".subnav button[data-sub]").forEach((b) => b.addEventListener("click", () => openSub(b.dataset.sub)));

/* ---------- rendering ---------- */
function fillLogos(root) {
  if (!window.MEDIALECT_LOGO) return;
  for (const img of $$("img[data-logo]:not([src])", root)) {
    window.MEDIALECT_LOGO(img.dataset.logo).then((s) => { img.src = s; }).catch(() => logoFailed(img, img.dataset.lib === "true"));
  }
}
window.logoFailed = (img) => {
  if (img.closest(".ms-list")) { img.remove(); return; }    // the filter shows the name next to it anyway
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = img.alt;
  img.replaceWith(name);
};
/* codec badges: an own small glyph + the name (the official Dolby/DTS logos are licensed trademarks) */
const glyph = (d, fill) => `<svg class="g" viewBox="0 0 16 16" aria-hidden="true"${fill ? ' fill="currentColor"' : ' fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'}>${d}</svg>`;
const G = {
  hdr: glyph('<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z"/>', true),
  dome: glyph('<path d="M2 12a6 6 0 0 1 12 0"/><path d="M5 12a3 3 0 0 1 6 0"/><circle cx="8" cy="12" r=".9" fill="currentColor"/>'),
  wave: glyph('<path d="M1.5 8h1.5M4.5 5v6M7 3v10M9.5 5.5v5M12 7v2M14.5 8h0"/>'),
  spk: glyph('<path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5"/>'),
  screen: glyph('<rect x="1.5" y="3" width="13" height="8.5" rx="1.2"/><path d="M5.5 14h5"/>'),
};
function codecBadge(tag, kind) {
  if (kind === "video") {
    const hdr = tag === "DV" || /HDR|HLG/.test(tag);
    const cls = tag === "DV" ? "c-dv" : tag === "HDR10+" ? "c-hdrp" : hdr ? "c-hdr" : "c-vid";
    return `<span class="tag codec ${cls}" title="${esc(tag === "DV" ? "Dolby Vision" : tag)}">${hdr ? G.hdr : G.screen}${esc(tag)}</span>`;
  }
  if (/^\d+\.\d|ch$/.test(tag)) return `<span class="tag codec c-ch" title="${esc(tag)}">${G.spk}${esc(tag)}</span>`;
  const cls = tag === "Atmos" ? "c-atmos" : /^DTS/.test(tag) ? "c-dts" : /^DD|TrueHD/.test(tag) ? "c-dd" : "c-aud";
  const title = { Atmos: "Dolby Atmos", DD: "Dolby Digital", "DD+": "Dolby Digital Plus", TrueHD: "Dolby TrueHD" }[tag] || tag;
  return `<span class="tag codec ${cls}" title="${esc(title)}">${tag === "Atmos" ? G.dome : G.wave}${esc(tag)}</span>`;
}
const CARET = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>`;
function renderOffer(o) {
  const tags = [];
  if (o.quality) tags.push(`<span class="tag q-${o.quality}">${QUALITY_LABEL[o.quality] || o.quality}</span>`);
  for (const v of o.video || []) tags.push(codecBadge(v, "video"));
  for (const a of o.audio || []) tags.push(codecBadge(a, "audio"));
  const mon = { free: t("offer.free"), ads: t("offer.ads"), addon: t("offer.addon") }[o.monetization] || "";
  // audio, subtitles and dates are hidden until the caret opens them
  const fl = (c) => `${langFlag(c)} ${c}`.trim();
  const rows = [];
  const lib = o.kind === "library";
  if (lib) rows.push(`<span class="li" title="${esc(t("offer.server"))}">${ICON.server}${esc(o.provider_name)}</span>`);
  if (o.audio_langs?.length) rows.push(`<span class="li" title="${esc(t("offer.audio"))}">${ICON.audio}${esc(o.audio_langs.map(fl).join(", "))}</span>`);
  if (o.subtitle_langs?.length) rows.push(`<span class="li" title="${esc(t("offer.subs"))}">${ICON.subs}${esc(o.subtitle_langs.map(fl).join(", "))}</span>`);
  const dates = [];
  if (o.added_at) dates.push(t("offer.added", { d: fmtDate(o.added_at) }));
  if (o.expires_on) dates.push(t("offer.until", { d: fmtDate(o.expires_on) }));
  if (dates.length) rows.push(`<span class="li">${ICON.date}${esc(dates.join(" · "))}</span>`);
  // streaming services and own servers: logo only (the server's name is in the details) (name as tooltip, shown instead when the logo cannot load);
  // own servers: their logo + the name from the settings
  // the app evens out the logos (same size, margins cut away) and fills them in after rendering
  const src = window.MEDIALECT_LOGO ? "" : ` src="${esc(o.icon)}"`;
  const logo = o.icon ? `<img class="svc-logo"${src} data-logo="${esc(o.icon)}" data-lib="${lib}" alt="${esc(o.provider_name)}" title="${esc(o.provider_name)}" loading="lazy" onerror="logoFailed(this, ${lib})">` : "";
  if (mon) tags.splice(o.quality ? 1 : 0, 0, `<span class="tag mon">${esc(mon)}</span>`);   // right after the resolution
  const head = `<span class="prov">${logo}${!o.icon ? `<span class="name">${esc(o.provider_name)}</span>` : ""}</span>
    <span class="tags">${tags.join("")}</span>`;
  // the box starts playback in the service's app; the caret only opens the details
  const main = o.url
    ? `<a class="offer-main" href="${esc(o.url)}" target="_blank" rel="noopener" title="${esc(`${t("offer.play")} – ${o.provider_name}`)}">${head}</a>`
    : `<div class="offer-main">${head}</div>`;
  const more = rows.length ? `<button type="button" class="more" aria-expanded="false" title="${esc(t("offer.details"))}" aria-label="${esc(t("offer.details"))}">${CARET}</button>` : "";
  return `<div class="offer ${o.kind}${o.url ? " link" : ""}">${main}${more}${rows.length ? `<div class="langs hidden">${rows.join("")}</div>` : ""}</div>`;
}
/* At most two rows of badges beside the logo: what wraps to a third row is hidden whole (measured, so it
   works with any font size); the opened details show them all. */
function clampTags(root) {
  requestAnimationFrame(() => {
    for (const box of root.querySelectorAll(".offer .tags")) {
      const tags = [...box.children];
      tags.forEach((t) => t.classList.remove("over"));
      const rows = [...new Set(tags.map((t) => t.offsetTop))].sort((a, b) => a - b);
      if (rows.length > 2) for (const t of tags) if (t.offsetTop > rows[1]) t.classList.add("over");
    }
  });
}
let clampTimer = null;
addEventListener("resize", () => { clearTimeout(clampTimer); clampTimer = setTimeout(() => clampTags($("#catalog")), 200); });
document.fonts?.ready?.then(() => clampTags($("#catalog")));
$("#catalog").addEventListener("click", (e) => {
  const more = e.target.closest(".offer .more");
  if (!more) return;
  e.preventDefault();
  const box = more.parentElement.querySelector(".langs");
  const open = box.classList.toggle("hidden") === false;
  more.parentElement.classList.toggle("open", open);
  more.setAttribute("aria-expanded", String(open));
});
// ratings: the site's icon instead of its name, coloured like ČSFD (red ≥ 70 %, blue 30–69 %, grey below)
const RATING_SITE = { csfd: "csfd.cz", imdb: "imdb.com", tmdb: "themoviedb.org", rottentomatoes: "rottentomatoes.com",
  rottentomatoes_audience: "rottentomatoes.com", metacritic: "metacritic.com", metacritic_user: "metacritic.com",
  letterboxd: "letterboxd.com", tvmaze: "tvmaze.com", trakt: "trakt.tv", mdblist: "mdblist.com", rogerebert: "rogerebert.com" };
const AUDIENCE = new Set(["rottentomatoes_audience", "metacritic_user"]);
function ratingIconFailed(img) { img.replaceWith(Object.assign(document.createElement("span"), { className: "r-name", textContent: img.alt })); }
function renderRating(r) {
  const name = RATING_LABEL[r.source] || r.source;
  const site = RATING_SITE[r.source];
  const icon = site ? `<img class="r-icon" src="https://icons.duckduckgo.com/ip3/${site}.ico" alt="${esc(name)}" loading="lazy" onerror="ratingIconFailed(this)">` : `<span class="r-name">${esc(name)}</span>`;
  const v = r.value;
  const band = v == null ? "" : v >= 70 ? " r-good" : v >= 30 ? " r-mid" : " r-low";
  // ČSFD without a number: on ČSFD but not rated yet (rating not started or nobody voted) = a lock, as on
  // ČSFD itself; not found on ČSFD = a question mark
  const none = v == null && r.source === "csfd";
  const inner = none ? `${icon}<span class="r-lock">${r.url ? ICON.lock : "<b>?</b>"}</span>`
    : `${icon}${AUDIENCE.has(r.source) ? ICON.people : ""}<b>${esc(r.display)}</b>`;
  const title = `${name}${r.votes ? ` · ${fmtNum(r.votes)}×` : ""}`;
  const cls = `rating ${esc(r.source)}${band}`;
  return r.url ? `<a class="${cls}" href="${esc(r.url)}" target="_blank" rel="noopener" title="${esc(title)}">${inner}</a>`
    : `<span class="${cls}" title="${esc(title)}">${inner}</span>`;
}
/* Emby/Jellyfin may fail to scale a picture the user picked by hand: ask once more for it unscaled
   (still resized for the screen by the WebView), then show the empty field */
function posterFailed(img) {
  const src = img.getAttribute("src") || "";
  if (!img.dataset.retry && /\/Images\/Primary/.test(src) && /[?&](maxHeight|maxWidth|fillHeight|fillWidth)=/.test(src)) {
    img.dataset.retry = "1";
    img.src = src.replace(/([?&])(maxHeight|maxWidth|fillHeight|fillWidth)=\d+&?/g, "$1").replace(/[?&]$/, "");
    return;
  }
  img.replaceWith(Object.assign(document.createElement("div"), { className: "noimg" }));
}
function renderTitle(ti) {
  const ratings = (ti.ratings || []).map(renderRating).join("");
  const meta = [ti.type === "movie" ? t("type.movie") : t("type.show"), ti.year].filter(Boolean).join(" · ");
  const sub = ti.original_title && ti.original_title !== ti.title ? ti.original_title : "";
  const img = ti.poster ? `<img loading="lazy" src="${esc(ti.poster)}" alt="" onerror="posterFailed(this)">` : `<div class="noimg"></div>`;
  return `<article class="title" data-id="${esc(ti.id)}">${img}<div>
    <h3>${esc(ti.title)} <span class="meta">${esc(meta)}</span></h3>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}
    <div class="ratings">${ratings}</div>
    <div class="offers">${(ti.where || []).map(renderOffer).join("")}</div>
  </div></article>`;
}

/* ---------- catalogue (with search), filters remembered per viewer ---------- */
let cPage = 1, catalogSeq = 0, searchTimer = null, facetsLoaded = false;
// multi-select filters: several values in one filter = any of them, different filters = all of them
const MULTI = [["cProvider", "provider", "f.allProviders"], ["cType", "type", "f.allTypes"],
               ["cQuality", "quality", "f.anyQuality"], ["cVideo", "video", "f.anyVideo"], ["cAudio", "audio", "f.anyAudio"],
               ["cLang", "lang", "f.anyAudioLang"], ["cSub", "sub", "f.anySub"]];
const FILTER_KEY = "medialect.filters";
let DEFAULT_SORT = "added";
const ms = {};                                   // id -> { items: [{value,label,count}], sel: Set }

const FILTERS_OPEN_KEY = "medialect.filtersOpen";
let filtersOpenedAt = 0;
function showFilters(open, remember = true) {
  $("#filters").classList.toggle("hidden", !open);
  $("#fToggle").setAttribute("aria-expanded", String(open));
  $("#fToggle").classList.toggle("on", open);
  filtersOpenedAt = scrollY;
  if (remember) try { localStorage.setItem(FILTERS_OPEN_KEY, open ? "1" : ""); } catch (_) { /* private mode */ }
}
// the open filters stay on top with the search field; scrolling the list folds them away
// (only a scroll by the user: a list that gets shorter after a filter change scrolls the page too)
let userScrollAt = 0;
for (const ev of ["touchmove", "wheel"]) addEventListener(ev, () => { userScrollAt = Date.now(); }, { passive: true });
addEventListener("keydown", (e) => { if (/^(Arrow(Up|Down)|Page(Up|Down)|Home|End| )$/.test(e.key)) userScrollAt = Date.now(); });
addEventListener("scroll", () => {
  if (Date.now() - userScrollAt > 700) { filtersOpenedAt = scrollY; return; }
  if ($("#filters").classList.contains("hidden") || Math.abs(scrollY - filtersOpenedAt) < 60) return;
  document.dispatchEvent(new Event("click"));        // closes an open dropdown
  showFilters(false, false);
}, { passive: true });
$("#fToggle").addEventListener("click", () => showFilters($("#filters").classList.contains("hidden")));
try { if (localStorage.getItem(FILTERS_OPEN_KEY)) showFilters(true); } catch (_) { /* private mode */ }
function filterCount() {
  const sortSet = ($("#cSort").value && $("#cSort").value !== DEFAULT_SORT) || sortDir !== defaultDir($("#cSort").value || DEFAULT_SORT);
  const n = MULTI.filter(([id]) => ms[id]?.sel.size).length + (sortSet ? 1 : 0);
  $("#fCount").textContent = n || "";
  $("#fCount").classList.toggle("hidden", !n);
  $("#cReset").classList.toggle("hidden", !n && !$("#q").value.trim());
}
function savedFilters() { try { return JSON.parse(localStorage.getItem(FILTER_KEY) || "{}"); } catch (_) { return {}; } }
function saveFilters() {
  const f = { cSort: $("#cSort").value, cOrder: sortDir };
  for (const [id] of MULTI) f[id] = [...ms[id].sel];
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(f)); } catch (_) { /* private mode */ }
  filterCount();
}
function setOptions(sel, items) {
  const keep = sel.value;
  sel.innerHTML = items.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

function msBuild(id, allKey) {
  const root = $(`#${id}`);
  ms[id] = { items: [], sel: new Set(), allKey };
  root.innerHTML = `<button type="button" class="ms-btn" aria-haspopup="true" aria-expanded="false"></button>
    <div class="ms-panel hidden" role="group"><div class="ms-list"></div>
    <button type="button" class="ghost ms-clear" data-i18n="f.clear">${esc(t("f.clear"))}</button></div>`;
  const btn = root.querySelector(".ms-btn"), panel = root.querySelector(".ms-panel");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = panel.classList.contains("hidden");
    $$(".ms-panel").forEach((p) => { p.classList.add("hidden"); p.previousElementSibling.setAttribute("aria-expanded", "false"); });
    panel.classList.toggle("hidden", !open);
    btn.setAttribute("aria-expanded", String(open));
    if (open) {                                  // keep the panel on screen near the right edge
      panel.style.left = ""; panel.style.right = "";
      if (panel.getBoundingClientRect().right > document.documentElement.clientWidth - 8) { panel.style.left = "auto"; panel.style.right = "0"; }
    }
  });
  panel.addEventListener("click", (e) => e.stopPropagation());
  panel.addEventListener("change", (e) => {
    if (!e.target.matches("input[type=checkbox]")) return;
    e.target.checked ? ms[id].sel.add(e.target.value) : ms[id].sel.delete(e.target.value);
    msLabel(id); filtersChanged();
  });
  root.querySelector(".ms-clear").addEventListener("click", () => { ms[id].sel.clear(); msRender(id); filtersChanged(); });
}
const svg = (d) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  service: svg('<rect x="2" y="5" width="20" height="13" rx="2"/><path d="M8 21h8"/>'),
  type: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>'),
  quality: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10v4M9 10v4M6 12h3M13 10v4h2a2 2 0 0 0 0-4z"/>'),
  video: svg('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  audio: svg('<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>'),
  lang: svg('<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15 9h7M18.5 7v2M16 15l2.5-6 2.5 6M16.8 13h3.4"/>'),
  subs: svg('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M10 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3"/>'),
  date: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  people: svg('<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 5a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6"/>'),
  sort: svg('<path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/>'),
  server: svg('<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>'),
  movie: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>'),
  show: svg('<rect x="2" y="5" width="20" height="13" rx="2"/><path d="M8 21h8M12 18v3"/>'),
};
const FILTER_ICON = { cProvider: ICON.service, cType: ICON.type, cQuality: ICON.quality, cVideo: ICON.video,
  cAudio: ICON.audio, cLang: ICON.lang, cSub: ICON.subs };
function msLabel(id) {
  const m = ms[id], chosen = m.items.filter((i) => m.sel.has(i.value));
  const btn = $(`#${id} .ms-btn`);
  const text = !chosen.length ? t(m.allKey) : chosen.length === 1 ? chosen[0].label : `${chosen[0].label} +${chosen.length - 1}`;
  btn.innerHTML = `${FILTER_ICON[id] || ""}<span>${esc(text)}</span>`;
  btn.classList.toggle("on", chosen.length > 0);
  btn.title = chosen.map((i) => i.label).join(", ") || t(m.allKey);
  filterCount();
}
function msRender(id) {
  const m = ms[id];
  $(`#${id} .ms-list`).innerHTML = m.items.map((i) => `<label><input type="checkbox" value="${esc(i.value)}" ${m.sel.has(i.value) ? "checked" : ""}>
    <span class="ms-item">${i.html || esc(i.label)}</span>${i.count != null ? `<small>${fmtNum(i.count)}</small>` : ""}</label>`).join("")
    || `<span class="muted">–</span>`;
  msLabel(id);
  fillLogos($(`#${id} .ms-list`));
}
function msSet(id, items) {
  const m = ms[id];
  m.items = items;
  if (facetsLoaded) for (const v of [...m.sel]) if (!items.some((i) => i.value === v)) m.sel.delete(v);
  msRender(id);
}
document.addEventListener("click", () => $$(".ms-panel").forEach((p) => {
  p.classList.add("hidden"); p.previousElementSibling.setAttribute("aria-expanded", "false"); }));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.dispatchEvent(new Event("click")); });

let filterTimer = null;
function filtersChanged() {
  saveFilters();
  clearTimeout(filterTimer); filterTimer = setTimeout(loadCatalog, 250);
}

async function loadFacets() {
  if (!ms.cProvider) for (const [id, , allKey] of MULTI) msBuild(id, allKey);
  if (!facetsLoaded) {                     // first load: restore the viewer's last choice (old single values too)
    const saved = savedFilters();
    for (const [id] of MULTI) {
      const v = saved[id];
      ms[id].sel = new Set(Array.isArray(v) ? v : v ? [v] : []);
    }
  }
  const [{ items }, f] = await Promise.all([api("/api/providers"), api("/api/facets")]);
  // the same logos and badges as at the titles; services in the user's order (the server sends them sorted)
  const logoHtml = (p) => {
    const lib = p.kind === "library";
    if (!p.icon) return `${lib ? ICON.server : ""}${esc(p.name)}`;
    const src = window.MEDIALECT_LOGO ? "" : ` src="${esc(p.icon)}"`;
    return `<img class="svc-logo sm"${src} data-logo="${esc(p.icon)}" data-lib="${lib}" alt="" onerror="this.remove()">${esc(p.name)}`;
  };
  msSet("cProvider", items.map((p) => ({ value: p.provider, label: p.name, html: logoHtml(p), count: p.titles })));
  msSet("cType", [{ value: "movie", label: t("f.movies"), html: `${ICON.movie}${esc(t("f.movies"))}` },
    { value: "show", label: t("f.shows"), html: `${ICON.show}${esc(t("f.shows"))}` }]);
  msSet("cQuality", f.quality.map((q) => ({ value: q.value, label: QUALITY_LABEL[q.value] || q.value,
    html: `<span class="tag q-${esc(q.value)}">${esc(QUALITY_LABEL[q.value] || q.value)}</span>`, count: q.titles })));
  msSet("cVideo", f.video.map((x) => ({ value: x.value, label: x.value, html: codecBadge(x.value, "video"), count: x.titles })));
  msSet("cAudio", f.audio.map((x) => ({ value: x.value, label: x.value, html: codecBadge(x.value, "audio"), count: x.titles })));
  const langs = (arr) => arr.map((x) => ({ value: x.value, label: langLabel(x.value), name: langName(x.value), count: x.titles }))
    .sort((a, b) => a.name.localeCompare(b.name, uiLang));
  msSet("cLang", langs(f.audio_langs));
  msSet("cSub", langs(f.subtitle_langs));
  const local = document.body.classList.contains("local");
  // newly added = the oldest known date of the title on the chosen services (JustWatch, own libraries)
  setOptions($("#cSort"), [{ value: "added", label: t("sort.added") }, { value: "year", label: t("sort.year") },
    ...f.ratings.map((r) => ({ value: r.value, label: t("sort.rating", { name: RATING_LABEL[r.value] || r.value }) }))]);
  if (!facetsLoaded) {
    const saved = savedFilters();
    const sel = $("#cSort");
    sel.value = saved.cSort && [...sel.options].some((o) => o.value === saved.cSort) ? saved.cSort : DEFAULT_SORT;
    sortDir = saved.cOrder === "asc" || saved.cOrder === "desc" ? saved.cOrder : defaultDir(sel.value);
    facetsLoaded = true;
  }
  sortRender();
}
let catalogTotal = null, catalogPages = 1, catalogBusy = false;
/* The catalogue grows as it is scrolled: the next page is added when the end comes near. Page marks
   let the floating buttons jump a page up or down. */
async function loadCatalog(append = false) {
  const seq = ++catalogSeq;
  if (!append) cPage = 1;
  const q = $("#q").value.trim();
  const sort = $("#cSort").value || DEFAULT_SORT;
  const params = new URLSearchParams({ page: cPage, page_size: 40, sort, order: sortDir });
  if (q.length >= 2) params.set("q", q);
  for (const [id, key] of MULTI) if (ms[id] && ms[id].sel.size) params.set(key, [...ms[id].sel].join(","));
  catalogBusy = true;
  try {
    const data = await api(`/api/catalog?${params}`);
    if (seq !== catalogSeq) return;
    catalogPages = Math.max(1, Math.ceil(data.total / data.page_size));
    let info = t("cat.count", { n: fmtNum(data.total) });
    $("#cInfo").textContent = info;
    catalogTotal = data.total;
    const html = data.items.map(renderTitle).join("");
    const before = append ? $("#catalog").children.length : 0;
    if (append) {
      $("#catalog").insertAdjacentHTML("beforeend", html);
    } else {
      $("#catalog").innerHTML = data.items.length ? html
        : `<p class="muted">${esc(t(syncRunning ? "cat.loading" : "cat.none"))}</p>`;
    }
    // the first title of each loaded page marks where the page starts (the page buttons jump to it)
    const first = data.items.length && $("#catalog").children[before];
    if (first) { first.classList.add("page-mark"); first.dataset.page = append ? cPage : 1; }
    fillLogos($("#catalog"));
    clampTags($("#catalog"));
    focusSoon();
    $("#more").classList.toggle("hidden", cPage >= catalogPages);
    fabUpdate();
  } catch (e) {
    if (seq !== catalogSeq) return;
    if (append) { cPage--; $("#more").textContent = e.message; } else $("#catalog").innerHTML = `<p class="err">${esc(e.message)}</p>`;
  } finally { if (seq === catalogSeq) catalogBusy = false; }
  if (seq === catalogSeq) moreIfNear();
}
function loadMore() {
  if (catalogBusy || cPage >= catalogPages || currentTab !== "catalog") return false;
  cPage++;
  loadCatalog(true);
  return true;
}
function moreIfNear() {
  const r = $("#more").getBoundingClientRect();
  if (!$("#more").classList.contains("hidden") && r.top < innerHeight + 800) loadMore();
}
addEventListener("scroll", () => { moreIfNear(); fabUpdate(); focusSoon(); }, { passive: true });

/* the ratings of the titles on screen are fetched first: the app says which ones they are (the ones in
   view, then the ones below them, then above), shortly after the list stops moving */
let focusTimer = null, lastFocus = "";
function focusSoon() { clearTimeout(focusTimer); focusTimer = setTimeout(sendFocus, 1200); }
function sendFocus() {
  if (currentTab !== "catalog") return;
  const all = $$("#catalog .title[data-id]");
  const top = 0, bottom = innerHeight;
  const inView = [], below = [], above = [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    (r.bottom < top ? above : r.top > bottom ? below : inView).push(Number(el.dataset.id));
  }
  const ids = [...inView, ...below, ...above.reverse()].slice(0, 200);
  const key = ids.join(",");
  if (!ids.length || key === lastFocus) return;
  lastFocus = key;
  api("/api/ratings/focus", { method: "POST", body: { ids } }).catch(() => {});
}

/* floating buttons once the list is long: to the top, one page up, one page down */
const pageMarks = () => $$("#catalog .page-mark");
function currentPage() {
  const top = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hdr")) || 0) + 70;
  let page = 1;
  for (const m of pageMarks()) if (m.getBoundingClientRect().top <= top + 1) page = Number(m.dataset.page);
  return page;
}
function goPage(n) {
  const m = $(`#catalog .page-mark[data-page="${n}"]`);
  if (n <= 1 || !m) { scrollTo({ top: 0, behavior: "smooth" }); return; }
  const off = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hdr")) || 0) + 60;
  scrollTo({ top: m.getBoundingClientRect().top + scrollY - off, behavior: "smooth" });
}
// the buttons appear while the list moves and fade away 2 s after it stops (or after the last tap on them)
let fabTimer = null;
function fabWake() {
  $("#fab").classList.remove("idle");
  clearTimeout(fabTimer);
  fabTimer = setTimeout(() => $("#fab").classList.add("idle"), 2000);
}
$("#fab").addEventListener("pointerdown", fabWake);
$("#fab").addEventListener("focusin", fabWake);
function fabUpdate() {
  const show = currentTab === "catalog" && scrollY > innerHeight * 1.2;
  $("#fab").classList.toggle("hidden", !show);
  if (!show) return;
  fabWake();
  const p = currentPage();
  $("#fabUp").disabled = p <= 1 && scrollY < 10;
  $("#fabDown").disabled = p >= catalogPages;
}
$("#fabTop").addEventListener("click", () => scrollTo({ top: 0, behavior: "smooth" }));
$("#fabUp").addEventListener("click", () => {
  const p = currentPage(), m = $(`#catalog .page-mark[data-page="${p}"]`);
  // inside a page: to its start first; at its start: to the page before
  const atStart = m && Math.abs(m.getBoundingClientRect().top - ((parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hdr")) || 0) + 60)) < 30;
  goPage(atStart || p === 1 ? p - 1 : p);
});
$("#fabDown").addEventListener("click", async () => {
  const p = currentPage();
  if (!$(`#catalog .page-mark[data-page="${p + 1}"]`)) {
    if (!loadMore()) return;
    for (let i = 0; i < 50 && catalogBusy; i++) await new Promise((r) => setTimeout(r, 100));
  }
  goPage(p + 1);
});
// the on-screen keyboard closes when the list is scrolled by finger or its search key is pressed
$("#q").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  clearTimeout(searchTimer); loadCatalog();
  $("#q").blur();
});
document.addEventListener("touchmove", () => { if (document.activeElement === $("#q")) $("#q").blur(); }, { passive: true });
$("#q").addEventListener("input", () => { filterCount(); clearTimeout(searchTimer); searchTimer = setTimeout(() => loadCatalog(), 250); });
$("#cSort").addEventListener("change", () => { sortDir = defaultDir($("#cSort").value); saveFilters(); sortRender(); loadCatalog(); });
let sortDir = "desc";
// newest / highest first, names from A
const defaultDir = (sort) => (sort === "title" ? "asc" : "desc");
const DIR_LABEL = (sort) => (sort === "title" ? ["sort.az", "sort.za"] : sort === "year" || sort === "added" ? ["sort.oldest", "sort.newest"]
  : ["sort.lowest", "sort.highest"]);
/* sorting: a dropdown like the filters, labelled "Sorting" (the hidden <select> keeps the value) */
function sortRender() {
  const root = $("#cSortBox"), sel = $("#cSort");
  if (!root.firstChild) {
    root.innerHTML = `<button type="button" class="ms-btn" aria-haspopup="true" aria-expanded="false"></button>
      <div class="ms-panel hidden" role="radiogroup"><div class="ms-list"></div></div>`;
    const btn = root.querySelector(".ms-btn"), panel = root.querySelector(".ms-panel");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = panel.classList.contains("hidden");
      $$(".ms-panel").forEach((p) => { p.classList.add("hidden"); p.previousElementSibling.setAttribute("aria-expanded", "false"); });
      panel.classList.toggle("hidden", !open);
      btn.setAttribute("aria-expanded", String(open));
      if (open) {
        panel.style.left = ""; panel.style.right = "";
        if (panel.getBoundingClientRect().right > document.documentElement.clientWidth - 8) { panel.style.left = "auto"; panel.style.right = "0"; }
      }
    });
    panel.addEventListener("click", (e) => e.stopPropagation());
    panel.addEventListener("change", (e) => {
      if (!e.target.matches("input[type=radio]")) return;
      if (e.target.name === "cDirR") {
        sortDir = e.target.value;
        saveFilters(); sortRender(); loadCatalog();
        return;
      }
      sel.value = e.target.value;
      sel.dispatchEvent(new Event("change"));
    });
  }
  const [ascKey, descKey] = DIR_LABEL(sel.value);
  root.querySelector(".ms-list").innerHTML = [...sel.options].map((o) => `<label><input type="radio" name="cSortR" value="${esc(o.value)}" ${o.value === sel.value ? "checked" : ""}><span>${esc(o.textContent)}</span></label>`).join("")
    + `<div class="ms-sep"></div>`
    + [["desc", descKey], ["asc", ascKey]].map(([v, k]) => `<label><input type="radio" name="cDirR" value="${v}" ${v === sortDir ? "checked" : ""}><span>${esc(t(k))}</span></label>`).join("");
  const btn = root.querySelector(".ms-btn");
  btn.innerHTML = `${ICON.sort}<span>${esc(t("f.sort"))}</span>`;
  btn.classList.toggle("on", (!!sel.value && sel.value !== DEFAULT_SORT) || sortDir !== defaultDir(sel.value));
  btn.title = `${t("f.sort")}: ${sel.selectedOptions[0]?.textContent || ""} – ${t(sortDir === "asc" ? ascKey : descKey)}`;
}
// closed by its ×: stays away for 10 minutes, whatever runs meanwhile (remembered across restarts)
const NOTE_QUIET_MS = 10 * 60 * 1000;
$("#syncNote .close").addEventListener("click", () => {
  try { localStorage.setItem("medialect.noteQuietUntil", String(Date.now() + NOTE_QUIET_MS)); } catch (_) { /* private mode */ }
  $("#syncNote").classList.add("hidden"); document.body.classList.remove("note-open");
});
const noteQuiet = () => { try { return Date.now() < Number(localStorage.getItem("medialect.noteQuietUntil") || 0); } catch (_) { return false; } };
$("#cReset").addEventListener("click", () => {
  $("#q").value = "";
  for (const [id] of MULTI) { ms[id].sel.clear(); msRender(id); }
  $("#cSort").value = DEFAULT_SORT;
  sortDir = defaultDir(DEFAULT_SORT);
  sortRender();
  saveFilters(); loadCatalog();
});

/* ---------- synchronisation status ---------- */
const fmtTime = (ts) => (ts ? new Date(ts * 1000).toLocaleString(uiLang) : "–");
const fmtDur = (sec) => { sec = Math.max(0, Math.round(sec)); const m = Math.floor(sec / 60); return m ? `${m} min ${sec % 60} s` : `${sec} s`; };
// plain words for everyone: the catalogue sources are "Catalogue", not JustWatch / Streaming Availability
const jobLabel = (j) => (j.id === "ratings" ? t("job.ratings") : j.id === "justwatch" ? t("job.catalog")
  : j.id === "sa" ? `${t("job.catalog")} (SA)` : j.label);
async function loadStatus() {
  const [st, stats] = await Promise.all([api("/api/sync/status"), api("/api/stats")]);
  updateSyncBadge(st.jobs.filter((j) => j.running), st.jobs.filter((j) => j.queued).length);
  if (st.running && !syncRunning) pollProgress();   // a run just started: switch the notice to fast polling
  $("#stats").textContent = t("sync.stats", { t: fmtNum(stats.titles), o: fmtNum(stats.offers), r: fmtNum(stats.ratings), d: fmtTime(st.last_full) });
  const now = Date.now() / 1000;
  $("#jobs").innerHTML = `<tr><th>${t("col.source")}</th><th>${t("col.status")}</th><th>${t("col.start")}</th><th>${t("col.items")}</th><th>${t("col.detail")}</th><th></th></tr>` +
    st.jobs.map((j) => {
      const l = j.last || {}, p = j.progress;
      const status = j.running ? "running" : j.queued ? "queued" : l.status;
      const started = p ? p.started_at : l.started_at;
      const items = p ? p.items : l.items;
      const bar = p && p.percent != null ? `<div class="bar"><i style="width:${p.percent}%"></i></div>` : "";
      const detail = p ? `<b>${esc(p.phase || "…")}</b>${p.percent != null ? ` · <b>${p.percent} %</b>` : ""} · ${esc(t("sync.runningFor", { d: fmtDur(now - p.started_at) }))}${bar}` : `<pre>${esc(l.message || "")}</pre>`;
      return `<tr><td>${esc(jobLabel(j))}</td>
        <td class="st-${status || ""}">${esc(status ? t(`st.${status}`) : t("st.never"))}</td>
        <td data-label="${esc(t("col.start"))}">${fmtTime(started)}</td><td data-label="${esc(t("col.items"))}">${items ?? ""}</td>
        <td>${detail}</td>
        <td><button class="ghost" data-job="${esc(j.id)}" ${j.running ? "disabled" : ""}>${esc(t("sync.run"))}</button></td></tr>`;
    }).join("");
  $$("#jobs button[data-job]").forEach((b) => b.addEventListener("click", async () => { await api(`/api/sync?job=${encodeURIComponent(b.dataset.job)}`, { method: "POST" }); setTimeout(loadStatus, 500); }));
  $("#budgets").textContent = t("sync.budgets", { sa: st.budgets.sa, csfd: st.budgets.csfd, mdb: st.budgets.mdblist, omdb: st.budgets.omdb });
}

/* header badge (admin): visible on every tab while something synchronises */
const pctText = (j) => (j.progress?.percent != null ? ` ${j.progress.percent}\u00a0%` : "");
function updateSyncBadge(running, queued) {
  lastBadge = [running, queued];
  const badge = $("#syncBadge");
  // the catalogue shows the same in its notice; the badge is for the other tabs
  badge.classList.toggle("hidden", !isAdmin || !running.length || !$("#tab-catalog").classList.contains("hidden"));
  if (running.length) {
    badge.textContent = `⟳ ${running.map((j) => `${jobLabel(j)}${pctText(j)}`).join(" · ")}${queued ? ` (${t("sync.queued", { n: queued })})` : ""}`;
    badge.title = running.map((j) => j.progress?.phase || "").filter(Boolean).join("\n");
  }
}

/* catalogue notice for everyone: what is being downloaded and how far it got */
let syncRunning = false, progressTimer = null, progressTicks = 0;
// nobody is reading or steering the list right now: it can be redrawn without the page jumping under the user
const catalogIdle = () => !$("#tab-catalog").classList.contains("hidden") && cPage === 1 && scrollY < 300
  && !$("#catalog").contains(document.activeElement) && document.activeElement !== $("#q") && $$(".ms-panel").every((p) => p.classList.contains("hidden"));
let syncNoteKey = "";
function updateSyncNote(st) {
  const note = $("#syncNote");
  syncNoteKey = st.running.map((j) => j.id).join(",");
  note.classList.toggle("hidden", !st.running.length || noteQuiet());
  document.body.classList.toggle("note-open", !note.classList.contains("hidden"));
  if (!st.running.length) return;
  const parts = st.running.map((j) => `${jobLabel(j)}${pctText(j)}`).join(" · ");
  note.querySelector("span").textContent = t(st.first ? "sync.noteFirst" : "sync.note", { p: parts });
  const known = st.running.map((j) => j.progress?.percent).filter((p) => p != null);
  note.querySelector(".bar").classList.toggle("hidden", !known.length);
  if (known.length) note.querySelector(".bar i").style.width = `${Math.round(known.reduce((a, b) => a + b, 0) / known.length)}%`;
}
async function pollProgress() {
  clearTimeout(progressTimer);
  try {
    const st = await api("/api/sync/progress");
    const was = syncRunning;
    syncRunning = st.running.length > 0;
    updateSyncNote(st);
    updateSyncBadge(st.running, st.queued);
    // the catalogue and its filters fill while data is downloaded: redraw when it is empty, when a run ends,
    // and every ~20 s during the first download as long as the viewer is not in the middle of the list
    const tick = syncRunning && st.first && ++progressTicks % 5 === 0 && catalogIdle();
    if ((syncRunning && !catalogTotal) || (was && !syncRunning) || tick) {
      loadFacets().catch(() => {}).then(() => loadCatalog());
      loadDataBy();
    }
  } catch (_) { /* ignore */ }
  progressTimer = setTimeout(pollProgress, syncRunning ? 4000 : 20000);
}

/* data attribution under the catalogue (required by Streaming Availability API's terms) */
const DATA_BY = {
  justwatch: '<a href="https://www.justwatch.com" target="_blank" rel="noopener">JustWatch</a>',
  sa: 'Streaming availability information is provided by <a href="https://www.movieofthenight.com/about/api" target="_blank" rel="noopener">Streaming Availability API by Movie of the Night</a>',
};
async function loadDataBy() {
  try {
    const st = await api("/api/stats");
    const parts = (st.sources || []).map((s) => DATA_BY[s]).filter(Boolean);
    $("#dataBy").innerHTML = parts.length ? `${esc(t("cat.dataBy"))} ${parts.join(" · ")}` : "";
  } catch (_) { /* ignore */ }
}
$("#syncBadge").addEventListener("click", () => { adminSub = "sync"; if (currentTab === "admin") openSub("sync"); else goTo("admin"); });
$("#syncAll").addEventListener("click", async () => { await api("/api/sync", { method: "POST" }); setTimeout(loadStatus, 500); });

/* ---------- catalogue settings ---------- */
let current = null;
const getPath = (o, p) => p.split(".").reduce((a, k) => a?.[k], o);
const setPath = (o, p, v) => { const ks = p.split("."); const last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; };

function fillChoices() {
  const country = $("#setCountry"), lang = $("#setLanguage");
  const cur = current || {};
  const countries = [...new Set([...COUNTRIES, (cur.country || "CZ").toUpperCase()])];
  country.innerHTML = countries.map((c) => ({ c, n: regionName(c) })).sort((a, b) => a.n.localeCompare(b.n, uiLang))
    .map(({ c, n }) => `<option value="${c}">${esc(regionLabel(c))}</option>`).join("");
  const langs = [...new Set([...TITLE_LANGS, cur.language || "cs"])];
  lang.innerHTML = langs.map((c) => ({ c, n: langName(c) })).sort((a, b) => a.n.localeCompare(b.n, uiLang))
    .map(({ c }) => `<option value="${c}">${esc(langLabel(c))}</option>`).join("");
}

/* Service picker: tiles (icon, name below). A tap/click selects or deselects (× also removes).
   The chosen ones come first in the user's order, which decides which service is listed first for each
   title in the catalogue. Reordering: hold a tile and drag it (touch), drag it (mouse), or on a remote/
   keyboard press OK on a chosen tile, move it with the arrows and confirm with OK. */
function servicePicker(box, items, selected, onChange) {
  // fixed items (own media servers) are always in the order: they can be moved, not removed
  const fixed = new Set(items.filter((p) => p.fixed).map((p) => p.short_name));
  let order = selected.filter((sn) => items.some((p) => p.short_name === sn));
  order = [...[...fixed].filter((sn) => !order.includes(sn)), ...order];
  let moving = null;   // remote/keyboard move mode: short_name of the tile being moved
  let dragging = null; // pointer drag: short_name of the dragged tile
  let rendering = false;
  const byName = (a, b) => a.name.localeCompare(b.name, uiLang);
  const hint = document.createElement("div");
  hint.className = "svc-hint"; hint.setAttribute("aria-live", "polite");
  const render = (focusSn) => {
    rendering = true;
    const chosen = order.map((sn) => items.find((p) => p.short_name === sn));
    const others = items.filter((p) => !order.includes(p.short_name)).sort(byName);
    box.innerHTML = [...chosen, ...others].map((p) => {
      const pos = order.indexOf(p.short_name);
      const on = pos >= 0;
      const cls = `svc${on ? " on" : " other"}${p.fixed ? " fixed" : ""}${p.short_name === moving ? " moving" : ""}${p.short_name === dragging ? " placeholder" : ""}`;
      return `<div class="${cls}" data-sn="${esc(p.short_name)}">
        <button type="button" class="svc-main" aria-pressed="${on}" title="${esc(p.name)}">
          ${p.icon ? `<img src="${esc(p.icon)}" alt="" draggable="false" data-initials="${esc(p.name.slice(0, 2))}" onerror="svcIconFailed(this)">` : `<span class="svc-noicon">${esc(p.name.slice(0, 2))}</span>`}
          <span class="svc-name">${esc(p.name)}</span>
        </button>
        ${on && !p.fixed ? `<button type="button" class="svc-x" data-remove title="${esc(t("svc.remove"))}" aria-label="${esc(t("svc.remove"))} ${esc(p.name)}">×</button>` : ""}
      </div>`;
    }).join("");
    hint.textContent = moving ? t("svc.moving") : "";
    hint.classList.toggle("hidden", !moving);
    if (!hint.isConnected) box.after(hint);
    if (focusSn) box.querySelector(`.svc[data-sn="${CSS.escape(focusSn)}"] .svc-main`)?.focus({ preventScroll: false });
    rendering = false;
  };
  // re-render with the tiles sliding from their old places to the new ones (like icons on a phone's home screen)
  const flip = (focusSn) => {
    const before = new Map([...box.querySelectorAll(".svc")].map((el) => [el.dataset.sn, el.getBoundingClientRect()]));
    render(focusSn);
    for (const el of box.querySelectorAll(".svc")) {
      const a = before.get(el.dataset.sn), b = el.getBoundingClientRect();
      if (!a || (a.left === b.left && a.top === b.top)) continue;
      el.style.transition = "none";
      el.style.transform = `translate(${a.left - b.left}px, ${a.top - b.top}px)`;
      el.getBoundingClientRect();                       // apply the start position before animating
      el.style.transition = "transform .18s ease-out";
      el.style.transform = "";
    }
  };
  const changed = (sn) => { flip(sn); onChange?.(order); };
  const move = (sn, to) => {
    const i = order.indexOf(sn);
    to = Math.max(0, Math.min(order.length - 1, to));
    if (i < 0 || to === i) return false;
    order.splice(i, 1); order.splice(to, 0, sn);
    return true;
  };
  const columns = () => {
    const tiles = [...box.querySelectorAll(".svc")];
    const top = tiles[0]?.offsetTop;
    return Math.max(1, tiles.filter((el) => el.offsetTop === top).length);
  };
  let swallowClick = false;
  box.onclick = (e) => {
    if (swallowClick) { swallowClick = false; e.preventDefault(); return; }
    const tile = e.target.closest(".svc");
    if (!tile) return;
    const sn = tile.dataset.sn;
    if (e.target.closest("[data-remove]")) {
      if (fixed.has(sn)) return;
      moving = null;
      order = order.filter((x) => x !== sn);
      changed(sn);
      return;
    }
    if (!e.target.closest(".svc-main")) return;
    const keyboard = e.detail === 0; // OK on a remote / Enter on a keyboard
    if (keyboard && order.includes(sn)) {
      moving = moving === sn ? null : sn; // OK starts moving, the next OK confirms
      render(sn);
      return;
    }
    if (fixed.has(sn)) return;                      // a server is switched off in its own settings
    moving = null;
    order = order.includes(sn) ? order.filter((x) => x !== sn) : [...order, sn];
    changed(sn);
  };
  box.onkeydown = (e) => {
    if (!moving) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns(), ArrowDown: columns() }[e.key];
    if (step) {
      e.preventDefault(); e.stopPropagation();
      const s = document.dir === "rtl" && Math.abs(step) === 1 ? -step : step;
      if (move(moving, order.indexOf(moving) + s)) changed(moving); else render(moving);
    } else if (e.key === "Escape" || e.key === "GoBack" || e.key === "BrowserBack") {
      e.preventDefault(); e.stopPropagation();
      const sn = moving; moving = null; render(sn);
    }
  };
  box.addEventListener("focusout", (e) => {
    if (moving && !rendering && !box.contains(e.relatedTarget)) { moving = null; hint.classList.add("hidden"); box.querySelector(".svc.moving")?.classList.remove("moving"); }
  });

  /* dragging: touch needs a short hold first (so the page still scrolls), the mouse starts on movement.
     Touch uses touch events, not pointer events: Chrome cancels a touch pointer as soon as it decides
     to scroll, while a touchmove that is prevented keeps coming. */
  let press = null;
  const HOLD_MS = 300, SLOP = 8;
  const pressAt = (target, x, y, touch) => {
    const tile = target.closest?.(".svc.on");
    if (!tile || !box.contains(tile) || target.closest("[data-remove]")) return;
    press = { sn: tile.dataset.sn, x, y, touch, before: [...order] };
    if (touch) press.timer = setTimeout(() => { if (press) startDrag(); }, HOLD_MS);
  };
  let ghost = null;
  const startDrag = () => {
    dragging = press.sn; moving = null;
    navigator.vibrate?.(15);
    const tile = box.querySelector(`.svc[data-sn="${CSS.escape(dragging)}"]`);
    if (tile) {
      // the tile lifts off under the finger; its place in the grid stays as a dashed gap
      const r = tile.getBoundingClientRect();
      ghost = tile.cloneNode(true);
      ghost.classList.add("svc-ghost");
      Object.assign(ghost.style, { width: `${r.width}px`, height: `${r.height}px` });
      press.dx = press.x - r.left; press.dy = press.y - r.top;
      document.body.append(ghost);
      moveGhost(press.x, press.y);
      tile.classList.add("placeholder");
    }
  };
  // the tile whose place in the grid is under the finger; layout positions ignore the sliding animation,
  // so a tile that is still moving away is not hit by mistake
  const tileAt = (x, y) => {
    for (const el of box.querySelectorAll(".svc.on")) {
      const pr = (el.offsetParent || document.body).getBoundingClientRect();
      const l = pr.left + el.offsetLeft, tp = pr.top + el.offsetTop;
      if (x >= l && x < l + el.offsetWidth && y >= tp && y < tp + el.offsetHeight) return el;
    }
    return null;
  };
  const moveGhost = (x, y) => { if (ghost) ghost.style.transform = `translate(${x - press.dx}px, ${y - press.dy}px) scale(1.06)`; };
  const dragTo = (x, y) => {
    if (!press) return;
    if (!dragging) {
      if (Math.hypot(x - press.x, y - press.y) <= SLOP) return;
      if (press.touch) { endDrag(false); return; } // moved before the hold ended: the user is scrolling
      startDrag();
    }
    moveGhost(x, y);
    // near the screen edge the page scrolls along (the finger cannot scroll it while dragging)
    if (y < 70) scrollBy(0, -14); else if (y > innerHeight - 70) scrollBy(0, 14);
    const over = tileAt(x, y);
    if (over && over.dataset.sn !== dragging && move(dragging, order.indexOf(over.dataset.sn))) {
      flip();
      // tiles were still sliding under a resting finger: look again once they settle
      clearTimeout(press.recheck);
      press.recheck = setTimeout(() => { if (dragging && press) dragTo(x, y); }, 220);
    }
  };
  const endDrag = (commit) => {
    if (press?.timer) clearTimeout(press.timer);
    if (press?.recheck) clearTimeout(press.recheck);
    ghost?.remove(); ghost = null;
    if (dragging) {
      swallowClick = true; setTimeout(() => { swallowClick = false; }, 250);
      const sn = dragging; dragging = null;
      if (!commit) order = press.before;
      if (commit && order.join() !== press.before.join()) { render(); onChange?.(order); } else render();
    }
    press = null;
  };
  box.addEventListener("mousedown", (e) => { if (e.button === 0) pressAt(e.target, e.clientX, e.clientY, false); });
  document.addEventListener("mousemove", (e) => { if (press && !press.touch) { dragTo(e.clientX, e.clientY); if (dragging) e.preventDefault(); } });
  document.addEventListener("mouseup", () => { if (press && !press.touch) endDrag(true); });
  // Touch events keep going to the element the finger first touched, even after the drag re-renders the
  // grid and that element leaves the page (then they no longer bubble), so they are also listened on it.
  // The grid itself has a non-passive touchmove listener from the start: Android's compositor decides by
  // the listeners present when the finger lands whether a touchmove may stop the page from scrolling.
  const onTouchMove = (ev) => {
    if (ev.mlSeen) return;
    ev.mlSeen = true;
    const tp = ev.touches[0];
    if (!tp || !press?.touch) return;
    dragTo(tp.clientX, tp.clientY);
    if (dragging && ev.cancelable) ev.preventDefault();      // a running drag must not scroll the page
  };
  box.addEventListener("touchmove", onTouchMove, { passive: false });
  box.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { endDrag(false); return; }
    pressAt(e.target, e.touches[0].clientX, e.touches[0].clientY, true);
    if (!press) return;
    const target = e.target;
    const done = (ev) => {
      if (ev.mlSeen) return;
      ev.mlSeen = true;
      target.removeEventListener("touchmove", onTouchMove);
      target.removeEventListener("touchend", done);
      target.removeEventListener("touchcancel", done);
      box.removeEventListener("touchend", done);
      box.removeEventListener("touchcancel", done);
      // a cancelled touch (the system took the gesture over) keeps what the drag already did
      if (press?.touch) endDrag(true);
    };
    target.addEventListener("touchmove", onTouchMove, { passive: false });
    for (const el of [target, box]) { el.addEventListener("touchend", done); el.addEventListener("touchcancel", done); }
  }, { passive: true });
  // a long press must not open the context menu or start the system's text selection / drag and drop
  document.addEventListener("contextmenu", (e) => { if (press?.touch && box.isConnected) e.preventDefault(); });
  box.addEventListener("contextmenu", (e) => { if (press?.touch) e.preventDefault(); });
  box.addEventListener("dragstart", (e) => e.preventDefault());
  render();
  return { value: () => [...order] };
}

let jwPicker = null;
function svcIconFailed(img) {
  img.replaceWith(Object.assign(document.createElement("span"), { className: "svc-noicon", textContent: img.dataset.initials || "?" }));
}
function serverIcon(srv) {
  if (!document.body.classList.contains("local")) return `/api/poster/${encodeURIComponent(srv.id)}?path=%2Fweb%2Ffavicon.ico`;
  const base = String((srv.link_mode !== "internal" && srv.public_url) || srv.url || "").replace(/\/+$/, "");
  return base ? `${base}/web/favicon.ico` : "";
}
async function loadJwProviders() {
  const box = $("#jwProviders");
  jwPicker = null;
  box.innerHTML = `<span class="muted">${esc(t("set.loading"))}</span>`;
  try {
    const { items } = await api(`/api/justwatch/providers?country=${encodeURIComponent($("#setCountry").value)}`);
    const selected = current.justwatch.providers || [];
    // own media servers are ordered together with the services (offers in the catalogue, ratings first)
    const servers = (current.servers || []).filter((srv) => srv.id && srv.url).map((srv) => ({
      short_name: `srv:${srv.id}`, name: srv.name || srv.type, fixed: true, icon: serverIcon(srv) }));
    jwPicker = servicePicker(box, [...servers, ...items], selected, () => markDirty(true));
    // services the user does not have stay hidden; one click shows the rest of the country's offer
    const anyChosen = items.some((p) => selected.includes(p.short_name));
    $("#jwShowAll").checked = !anyChosen;
    $("#jwShowAll").closest("label").classList.toggle("hidden", !anyChosen);
    box.classList.toggle("all", !anyChosen);
    $("#jwShowAll").nextElementSibling.textContent = t("set.jw.showAll", { n: items.length });
  } catch (e) {
    box.innerHTML = `<span class="err">${esc(e.message)}</span>`;
    $("#jwShowAll").closest("label").classList.add("hidden");
  }
}

function markDirty(dirty) {
  $("#saveSettings").classList.toggle("attention", dirty);
  $("#saveMsg").textContent = dirty ? t("set.unsaved") : "";
  $("#saveMsg").classList.toggle("dirty", dirty);
}

async function loadSettings() {
  current = await api("/api/settings");
  fillChoices();
  const f = $("#settingsForm");
  for (const el of $$("[name]", f)) {
    const v = getPath(current, el.name);
    if (el.type === "checkbox") el.checked = !!v; else el.value = v ?? "";
  }
  $("#servers").innerHTML = "";
  current.servers.forEach(addServerRow);
  const sel = new Set(current.streaming_availability.catalogs || []);
  $("#saCatalogs").innerHTML = SA_CATALOGS.map((c) => `<label><input type="checkbox" value="${c}" ${sel.has(c) ? "checked" : ""}>${c}</label>`).join("");
  markDirty(false);
  loadJwProviders();
}
$("#jwShowAll").addEventListener("change", (e) => { e.stopPropagation(); $("#jwProviders").classList.toggle("all", e.target.checked); });
$("#settingsForm").addEventListener("input", (e) => { if (e.target.id !== "jwShowAll") markDirty(true); });
$("#settingsForm").addEventListener("change", (e) => { if (e.target.id === "jwShowAll") return; markDirty(true); if (e.target.id === "setCountry") loadJwProviders(); });
$("#settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {};
  for (const el of $$("[name]", e.target)) setPath(body, el.name, el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value.trim());
  if (jwPicker) body.justwatch.providers = jwPicker.value();
  body.streaming_availability.catalogs = $$("#saCatalogs input:checked").map((i) => i.value);
  $("#saveMsg").textContent = t("srv.saving");
  try {
    // media servers first (each row reports its own result), then the catalogue settings
    const rows = $$("#servers .server").filter((n) => n.dataset.dirty || !n.dataset.id);
    const filled = rows.filter((n) => $("[data-k=url]", n).value.trim());
    const ok = (await Promise.all(filled.map((n) => n.saveNow()))).every(Boolean);
    current = await api("/api/settings", { method: "PUT", body });
    if (!ok) { markDirty(true); $("#saveMsg").textContent = t("srv.error"); return; }
    await loadSettings();
    $("#saveMsg").textContent = t("set.saved");
  } catch (err) { $("#saveMsg").textContent = err.message; }
});

/* ---------- first-run wizard ---------- */
const LANG_COUNTRY = { cs: "CZ", sk: "SK", de: "DE", pl: "PL", hu: "HU", fr: "FR", es: "ES", it: "IT", pt: "PT", nl: "NL",
  sv: "SE", da: "DK", nb: "NO", fi: "FI", uk: "UA", ro: "RO", hr: "HR", sl: "SI", tr: "TR", en: "GB",
  zh: "TW", hi: "IN", ar: "AE", ja: "JP", ko: "KR", id: "ID" };
let wizStepNo = 1, wizProvidersFor = null, wizPicker = null;
function guessCountry() {
  for (const l of navigator.languages || [navigator.language]) {
    const r = (l || "").split("-")[1];
    if (r && COUNTRIES.includes(r.toUpperCase())) return r.toUpperCase();
  }
  return LANG_COUNTRY[uiLang] || "US";
}
function startWizard() {
  const country = $("#wizCountry"), lang = $("#wizLanguage");
  country.innerHTML = COUNTRIES.map((c) => ({ c, n: regionName(c) })).sort((a, b) => a.n.localeCompare(b.n, uiLang))
    .map(({ c }) => `<option value="${c}">${esc(regionLabel(c))}</option>`).join("");
  lang.innerHTML = TITLE_LANGS.map((c) => ({ c, n: langName(c) })).sort((a, b) => a.n.localeCompare(b.n, uiLang))
    .map(({ c }) => `<option value="${c}">${esc(langLabel(c))}</option>`).join("");
  country.value = guessCountry();
  const l = uiLang === "nb" ? "no" : uiLang;
  lang.value = TITLE_LANGS.includes(l) ? l : "en";
  wizShow(1);
}
function wizShow(n) {
  wizStepNo = n;
  $$("#wizard [data-step]").forEach((d) => d.classList.toggle("hidden", Number(d.dataset.step) !== n));
  $("#wizStep").textContent = t("wiz.step", { n, m: 3 });
  $("#wizBack").classList.toggle("hidden", n === 1);
  $("#wizNext").textContent = n === 3 ? t("wiz.finish") : t("wiz.next");
  $("#wizMsg").textContent = "";
  if (n === 2) wizLoadProviders();
  if (n === 3) $("#wizCsfd").closest("label").classList.toggle("hidden", !["CZ", "SK"].includes($("#wizCountry").value));
}
async function wizLoadProviders() {
  const c = $("#wizCountry").value, box = $("#wizProviders");
  if (wizProvidersFor === c) return;
  box.innerHTML = `<span class="muted">${esc(t("set.loading"))}</span>`;
  try {
    const { items } = await api(`/api/justwatch/providers?country=${encodeURIComponent(c)}`);
    wizPicker = servicePicker(box, items, []);
    wizProvidersFor = c;
  } catch (e) { box.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
}
$("#wizBack").addEventListener("click", () => wizShow(Math.max(1, wizStepNo - 1)));
$("#wizNext").addEventListener("click", async () => {
  if (wizStepNo < 3) { wizShow(wizStepNo + 1); return; }
  const btn = $("#wizNext");
  btn.disabled = true;
  const country = $("#wizCountry").value;
  const body = {
    country, language: $("#wizLanguage").value,
    justwatch: { enabled: true, providers: wizPicker ? wizPicker.value() : [] },
    ratings: { imdb_dataset: $("#wizImdb").checked, tvmaze: $("#wizTvmaze").checked,
               csfd: ["CZ", "SK"].includes(country) && $("#wizCsfd").checked },
  };
  try {
    await api("/api/settings", { method: "PUT", body });
    await api("/api/onboarding/done", { method: "POST" });
    adminSub = "sync";
    openAdmin();
  } catch (e) { $("#wizMsg").textContent = e.message; }
  btn.disabled = false;
});
$("#wizSkip").addEventListener("click", async () => {
  try { await api("/api/onboarding/done", { method: "POST" }); } catch (_) { /* ignore */ }
  openAdmin();
});

/* ---------- media servers (each saved on its own) ---------- */
function fillServer(node, srv) {
  node.dataset.id = srv.id || "";
  for (const el of $$("[data-k]", node)) {
    const v = srv[el.dataset.k];
    if (el.type === "checkbox") el.checked = v ?? true;
    else if (v !== undefined) el.value = v;
    else if (el.dataset.k === "link_mode") el.value = "auto";
  }
  if (document.body.classList.contains("local")) {
    const mode = $("[data-k=link_mode]", node);
    $("option[value=auto]", mode)?.remove();
    if (srv.link_mode !== "internal") mode.value = "public";
  }
  node.classList.toggle("unsaved", !srv.id);
}
function addServerRow(srv = {}) {
  const node = $("#serverTpl").content.firstElementChild.cloneNode(true);
  // where the key is found depends on the server type
  const keyHelp = () => {
    const el = $(".key-help", node), type = $("[data-k=type]", node).value || "emby";
    el.dataset.i18n = `srv.key.${type}`; el.textContent = t(el.dataset.i18n);
  };
  $("[data-k=type]", node).addEventListener("change", keyHelp);
  applyI18n(node);
  helpToggles(node);
  fillServer(node, srv);
  keyHelp();
  const res = $(".result", node);
  const say = (text, cls = "muted") => { res.textContent = text; res.className = `${cls} result`; };
  $$("[data-k]", node).forEach((el) => el.addEventListener("input", () => say(node.dataset.id ? t("srv.unsaved") : t("srv.new"))));
  // changes are saved by the one save button of the settings
  $$("[data-k]", node).forEach((el) => el.addEventListener("input", () => { node.dataset.dirty = "1"; markDirty(true); }));
  $$("[data-k]", node).forEach((el) => el.addEventListener("change", () => { node.dataset.dirty = "1"; markDirty(true); }));
  node.saveNow = async () => {
    say(t("srv.saving"));
    try {
      const saved = await api("/api/servers", { method: "POST", body: readServer(node) });
      fillServer(node, saved);
      delete node.dataset.dirty;
      say(t("srv.saved"), "ok");
      return true;
    } catch (e) { say(`${t("srv.error")}: ${e.message}`, "err"); return false; }
  };
  $(".test", node).addEventListener("click", async () => {
    say(t("srv.testing"));
    try {
      const r = await api("/api/servers/test", { method: "POST", body: readServer(node) });
      r.ok ? say(`${t("srv.ok")} – ${r.info.name || ""} ${r.info.version || ""}${r.info.via ? ` (${r.info.via})` : ""}`, "ok") : say(`${t("srv.error")}: ${r.error}`, "err");
    } catch (e) { say(`${t("srv.error")}: ${e.message}`, "err"); }
  });
  $(".remove", node).addEventListener("click", async () => {
    if (!node.dataset.id) { node.remove(); return; }
    if (!confirm(t("srv.confirmRemove", { name: $("[data-k=name]", node).value || "server" }))) return;
    try { await api(`/api/servers/${encodeURIComponent(node.dataset.id)}`, { method: "DELETE" }); node.remove(); }
    catch (e) { say(`${t("srv.error")}: ${e.message}`, "err"); }
  });
  $("#servers").appendChild(node);
  return node;
}
function readServer(node) {
  const s = { id: node.dataset.id || undefined };
  for (const el of $$("[data-k]", node)) s[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value.trim();
  return s;
}
$("#addServer").addEventListener("click", () => $("[data-k=name]", addServerRow({ type: "emby", link_mode: "auto" })).focus());

/* ---------- access ---------- */
$("#showToken").addEventListener("click", async () => { $("#apiToken").textContent = (await api("/api/auth/token")).token; });
$("#regenToken").addEventListener("click", async () => {
  if (!confirm(t("acc.regenConfirm"))) return;
  $("#apiToken").textContent = (await api("/api/auth/token/regenerate", { method: "POST" })).token;
});
$("#pwForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try { await api("/api/auth/password", { method: "POST", body: { old: fd.get("old"), new: fd.get("new") } }); $("#pwMsg").textContent = t("acc.pwDone"); e.target.reset(); }
  catch (err) { $("#pwMsg").textContent = err.message; }
});

boot();

/* the search bar sticks right below the top bar, whose height changes with the layout */
{
  const hdr = document.querySelector("#app > header");
  const setHdr = () => document.documentElement.style.setProperty("--hdr", `${hdr.offsetHeight}px`);
  if (hdr) { setHdr(); new ResizeObserver(setHdr).observe(hdr); }
}
