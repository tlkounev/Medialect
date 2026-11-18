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
    DEFAULT_SORT = "year";        // no source in the app knows when a service added a title
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
document.addEventListener("click", (e) => { if (!e.target.closest(".lang-menu")) langMenu(false); });
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
  history.replaceState(null, "", `#${name}`);
  clearInterval(statusTimer);
  updateSyncBadge(...lastBadge);
  if (name === "catalog") loadFacets().catch(() => {}).then(loadCatalog);
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
function openSub(name) {
  adminSub = name;
  clearInterval(statusTimer);
  $$(".subnav button[data-sub]").forEach((b) => b.classList.toggle("active", b.dataset.sub === name));
  $("#sub-sync").classList.toggle("hidden", name !== "sync");
  $("#sub-settings").classList.toggle("hidden", name !== "settings");
  if (name === "sync") { loadStatus(); statusTimer = setInterval(loadStatus, 5000); }
  if (name === "settings") loadSettings();
}
$("#openSettings").addEventListener("click", () => openTab(currentTab === "admin" ? "catalog" : "admin"));
$("#home").addEventListener("click", (e) => { if (!e.target.closest("a")) openTab("catalog"); });
$("#home").addEventListener("keydown", (e) => { if (e.key === "Enter") openTab("catalog"); });
$$(".subnav [data-back]").forEach((b) => b.addEventListener("click", () => openTab("catalog")));
$$(".subnav button[data-sub]").forEach((b) => b.addEventListener("click", () => openSub(b.dataset.sub)));

/* ---------- rendering ---------- */
function fillLogos(root) {
  if (!window.MEDIALECT_LOGO) return;
  for (const img of $$("img[data-logo]:not([src])", root)) {
    window.MEDIALECT_LOGO(img.dataset.logo).then((s) => { img.src = s; }).catch(() => logoFailed(img, img.dataset.lib === "true"));
  }
}
window.logoFailed = (img, lib) => {
  if (lib) { img.remove(); return; }
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = img.alt;
  img.replaceWith(name);
};
function renderOffer(o) {
  const tags = [];
  if (o.quality) tags.push(`<span class="tag q-${o.quality}">${QUALITY_LABEL[o.quality] || o.quality}</span>`);
  for (const v of o.video || []) tags.push(`<span class="tag ${/DV|HDR|HLG/.test(v) ? "hdr" : ""}">${esc(v)}</span>`);
  for (const a of o.audio || []) tags.push(`<span class="tag ${/Atmos|DTS:X/.test(a) ? "aud" : ""}">${esc(a)}</span>`);
  const mon = { free: t("offer.free"), ads: t("offer.ads"), addon: t("offer.addon") }[o.monetization] || "";
  // audio and subtitles: an icon instead of the word, flags with the code
  const fl = (c) => `${langFlag(c)} ${c}`.trim();
  const rows = [];
  if (o.audio_langs?.length) rows.push(`<span class="li" title="${esc(t("offer.audio"))}">${ICON.audio}${esc(o.audio_langs.map(fl).join(", "))}</span>`);
  if (o.subtitle_langs?.length) rows.push(`<span class="li" title="${esc(t("offer.subs"))}">${ICON.subs}${esc(o.subtitle_langs.slice(0, 8).map(fl).join(", "))}${o.subtitle_langs.length > 8 ? "…" : ""}</span>`);
  const dates = [];
  if (o.added_at) dates.push(t("offer.added", { d: fmtDate(o.added_at) }));
  if (o.expires_on) dates.push(t("offer.until", { d: fmtDate(o.expires_on) }));
  if (dates.length) rows.push(`<span class="li">${esc(dates.join(" · "))}</span>`);
  const lib = o.kind === "library";
  // streaming services: logo only (name as tooltip, shown instead when the logo cannot load);
  // own servers: their logo + the name from the settings
  // the app evens out the logos (same size, margins cut away) and fills them in after rendering
  const src = window.MEDIALECT_LOGO ? "" : ` src="${esc(o.icon)}"`;
  const logo = o.icon ? `<img class="svc-logo"${src} data-logo="${esc(o.icon)}" data-lib="${lib}" alt="${esc(o.provider_name)}" title="${esc(o.provider_name)}" loading="lazy" onerror="logoFailed(this, ${lib})">` : "";
  const body = `<span class="prov">${logo}${lib || !o.icon ? `<span class="name">${esc(o.provider_name)}</span>` : ""}</span>${mon ? `<span class="muted mon">${esc(mon)}</span>` : ""}
    <span class="tags">${tags.join("")}</span><span class="langs">${rows.join("")}</span>`;
  // the whole box starts playback in the service's app
  return o.url
    ? `<a class="offer ${o.kind}" href="${esc(o.url)}" target="_blank" rel="noopener" title="${esc(`${t("offer.play")} – ${o.provider_name}`)}">${body}</a>`
    : `<div class="offer ${o.kind}">${body}</div>`;
}
function renderTitle(ti) {
  const ratings = (ti.ratings || []).map((r) => {
    const inner = `${esc(RATING_LABEL[r.source] || r.source)} <b>${esc(r.display)}</b>`;
    return r.url ? `<a class="rating" href="${esc(r.url)}" target="_blank" rel="noopener">${inner}</a>` : `<span class="rating">${inner}</span>`;
  }).join("");
  const meta = [ti.type === "movie" ? t("type.movie") : t("type.show"), ti.year].filter(Boolean).join(" · ");
  const sub = ti.original_title && ti.original_title !== ti.title ? ti.original_title : "";
  const img = ti.poster ? `<img loading="lazy" src="${esc(ti.poster)}" alt="">` : `<div class="noimg"></div>`;
  return `<article class="title">${img}<div>
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
function showFilters(open) {
  $("#filters").classList.toggle("hidden", !open);
  $("#fToggle").setAttribute("aria-expanded", String(open));
  $("#fToggle").classList.toggle("on", open);
  try { localStorage.setItem(FILTERS_OPEN_KEY, open ? "1" : ""); } catch (_) { /* private mode */ }
}
$("#fToggle").addEventListener("click", () => showFilters($("#filters").classList.contains("hidden")));
try { if (localStorage.getItem(FILTERS_OPEN_KEY)) showFilters(true); } catch (_) { /* private mode */ }
function filterCount() {
  const n = MULTI.filter(([id]) => ms[id]?.sel.size).length + ($("#cSort").value && $("#cSort").value !== DEFAULT_SORT ? 1 : 0);
  $("#fCount").textContent = n || "";
  $("#fCount").classList.toggle("hidden", !n);
}
function savedFilters() { try { return JSON.parse(localStorage.getItem(FILTER_KEY) || "{}"); } catch (_) { return {}; } }
function saveFilters() {
  const f = { cSort: $("#cSort").value };
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
    <span>${esc(i.label)}</span>${i.count != null ? `<small>${fmtNum(i.count)}</small>` : ""}</label>`).join("")
    || `<span class="muted">–</span>`;
  msLabel(id);
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
  cPage = 1; saveFilters();
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
  msSet("cProvider", items.map((p) => ({ value: p.provider, label: p.name, count: p.titles })));
  msSet("cType", [{ value: "movie", label: t("f.movies") }, { value: "show", label: t("f.shows") }]);
  msSet("cQuality", f.quality.map((q) => ({ value: q.value, label: QUALITY_LABEL[q.value] || q.value, count: q.titles })));
  msSet("cVideo", f.video.map((x) => ({ value: x.value, label: x.value, count: x.titles })));
  msSet("cAudio", f.audio.map((x) => ({ value: x.value, label: x.value, count: x.titles })));
  const langs = (arr) => arr.map((x) => ({ value: x.value, label: langLabel(x.value), name: langName(x.value), count: x.titles }))
    .sort((a, b) => a.name.localeCompare(b.name, uiLang));
  msSet("cLang", langs(f.audio_langs));
  msSet("cSub", langs(f.subtitle_langs));
  const local = document.body.classList.contains("local");
  setOptions($("#cSort"), [...(local ? [] : [{ value: "added", label: t("sort.added") }]), { value: "year", label: t("sort.year") },
    { value: "title", label: t("sort.title") },
    ...f.ratings.map((r) => ({ value: r.value, label: t("sort.rating", { name: RATING_LABEL[r.value] || r.value }) }))]);
  if (!facetsLoaded) {
    const saved = savedFilters();
    const sel = $("#cSort");
    sel.value = saved.cSort && [...sel.options].some((o) => o.value === saved.cSort) ? saved.cSort : DEFAULT_SORT;
    facetsLoaded = true;
  }
}
let catalogTotal = null;
async function loadCatalog() {
  const seq = ++catalogSeq;
  const q = $("#q").value.trim();
  const sort = $("#cSort").value || DEFAULT_SORT;
  const params = new URLSearchParams({ page: cPage, page_size: 40, sort, order: sort === "title" ? "asc" : "desc" });
  if (q.length >= 2) params.set("q", q);
  for (const [id, key] of MULTI) if (ms[id] && ms[id].sel.size) params.set(key, [...ms[id].sel].join(","));
  try {
    const data = await api(`/api/catalog?${params}`);
    if (seq !== catalogSeq) return;
    const pages = Math.max(1, Math.ceil(data.total / data.page_size));
    let info = t("cat.count", { n: fmtNum(data.total) });
    if (data.total > data.page_size) info += ` · ${t("cat.page", { p: data.page, n: pages })}`;
    if (sort === "added") info += ` · ${t("cat.addedNote")}`;
    $("#cInfo").textContent = info;
    catalogTotal = data.total;
    $("#catalog").innerHTML = data.items.length ? data.items.map(renderTitle).join("") : `<p class="muted">${esc(t(syncRunning ? "cat.loading" : "cat.none"))}</p>`;
    fillLogos($("#catalog"));
    $("#cPrev").disabled = cPage <= 1;
    $("#cNext").disabled = cPage >= pages;
    $(".pager").classList.toggle("hidden", pages <= 1);
  } catch (e) { $("#catalog").innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
$("#q").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { cPage = 1; loadCatalog(); }, 250); });
$("#cSort").addEventListener("change", () => { cPage = 1; saveFilters(); loadCatalog(); });
$("#syncNote .close").addEventListener("click", () => { syncNoteClosed = syncNoteKey; $("#syncNote").classList.add("hidden"); });
$("#cReset").addEventListener("click", () => {
  $("#q").value = "";
  for (const [id] of MULTI) { ms[id].sel.clear(); msRender(id); }
  $("#cSort").value = DEFAULT_SORT;
  cPage = 1; saveFilters(); loadCatalog();
});
$("#cPrev").addEventListener("click", () => { cPage--; loadCatalog(); scrollTo(0, 0); });
$("#cNext").addEventListener("click", () => { cPage++; loadCatalog(); scrollTo(0, 0); });

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
let syncNoteKey = "", syncNoteClosed = null;
function updateSyncNote(st) {
  const note = $("#syncNote");
  syncNoteKey = st.running.map((j) => j.id).join(",");
  note.classList.toggle("hidden", !st.running.length || syncNoteClosed === syncNoteKey);
  if (!st.running.length) { syncNoteClosed = null; return; }
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
      loadFacets().catch(() => {}).then(loadCatalog);
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
$("#syncBadge").addEventListener("click", () => { adminSub = "sync"; openTab("admin"); });
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
  let order = selected.filter((sn) => items.some((p) => p.short_name === sn));
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
      const cls = `svc${on ? " on" : " other"}${p.short_name === moving ? " moving" : ""}${p.short_name === dragging ? " dragging" : ""}`;
      return `<div class="${cls}" data-sn="${esc(p.short_name)}">
        <button type="button" class="svc-main" aria-pressed="${on}" title="${esc(p.name)}">
          ${p.icon ? `<img src="${esc(p.icon)}" alt="" draggable="false">` : `<span class="svc-noicon">${esc(p.name.slice(0, 2))}</span>`}
          <span class="svc-name">${esc(p.name)}</span>${on ? `<span class="svc-pos">${pos + 1}</span>` : ""}
        </button>
        ${on ? `<button type="button" class="svc-x" data-remove title="${esc(t("svc.remove"))}" aria-label="${esc(t("svc.remove"))} ${esc(p.name)}">×</button>` : ""}
      </div>`;
    }).join("");
    hint.textContent = moving ? t("svc.moving") : "";
    hint.classList.toggle("hidden", !moving);
    if (!hint.isConnected) box.after(hint);
    if (focusSn) box.querySelector(`.svc[data-sn="${CSS.escape(focusSn)}"] .svc-main`)?.focus({ preventScroll: false });
    rendering = false;
  };
  const changed = (sn) => { render(sn); onChange?.(order); };
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
  const startDrag = () => {
    dragging = press.sn; moving = null;
    navigator.vibrate?.(15);
    box.querySelector(`.svc[data-sn="${CSS.escape(dragging)}"]`)?.classList.add("dragging");
  };
  const dragTo = (x, y) => {
    if (!press) return;
    if (!dragging) {
      if (Math.hypot(x - press.x, y - press.y) <= SLOP) return;
      if (press.touch) { endDrag(false); return; } // moved before the hold ended: the user is scrolling
      startDrag();
    }
    const over = document.elementFromPoint(x, y)?.closest(".svc.on");
    if (over && box.contains(over) && over.dataset.sn !== dragging && move(dragging, order.indexOf(over.dataset.sn))) render();
  };
  const endDrag = (commit) => {
    if (press?.timer) clearTimeout(press.timer);
    if (dragging) {
      swallowClick = true; setTimeout(() => { swallowClick = false; }, 250);
      const sn = dragging; dragging = null;
      if (!commit) order = press.before;
      if (commit && order.join() !== press.before.join()) changed(sn); else render();
    }
    press = null;
  };
  box.addEventListener("mousedown", (e) => { if (e.button === 0) pressAt(e.target, e.clientX, e.clientY, false); });
  document.addEventListener("mousemove", (e) => { if (press && !press.touch) { dragTo(e.clientX, e.clientY); if (dragging) e.preventDefault(); } });
  document.addEventListener("mouseup", () => { if (press && !press.touch) endDrag(true); });
  box.addEventListener("touchstart", (e) => { if (e.touches.length === 1) pressAt(e.target, e.touches[0].clientX, e.touches[0].clientY, true); else endDrag(false); }, { passive: true });
  // listened on the document: the touched tile is re-rendered during the drag and touch events keep
  // targeting the detached element; once a drag runs, the finger must not scroll the page
  document.addEventListener("touchmove", (e) => {
    if (!press?.touch || !box.isConnected) return;
    const tp = e.touches[0];
    dragTo(tp.clientX, tp.clientY);
    if (dragging && e.cancelable) e.preventDefault();
  }, { passive: false });
  document.addEventListener("touchend", () => { if (press?.touch) endDrag(true); });
  document.addEventListener("touchcancel", () => { if (press?.touch) endDrag(false); });
  box.addEventListener("contextmenu", (e) => { if (press?.touch) e.preventDefault(); });
  box.addEventListener("dragstart", (e) => e.preventDefault());
  render();
  return { value: () => [...order] };
}

let jwPicker = null;
async function loadJwProviders() {
  const box = $("#jwProviders");
  jwPicker = null;
  box.innerHTML = `<span class="muted">${esc(t("set.loading"))}</span>`;
  try {
    const { items } = await api(`/api/justwatch/providers?country=${encodeURIComponent($("#setCountry").value)}`);
    const selected = current.justwatch.providers || [];
    jwPicker = servicePicker(box, items, selected, () => markDirty(true));
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
  try {
    current = await api("/api/settings", { method: "PUT", body });
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
  applyI18n(node);
  fillServer(node, srv);
  const res = $(".result", node);
  const say = (text, cls = "muted") => { res.textContent = text; res.className = `${cls} result`; };
  $$("[data-k]", node).forEach((el) => el.addEventListener("input", () => say(node.dataset.id ? t("srv.unsaved") : t("srv.new"))));
  $(".save", node).addEventListener("click", async () => {
    say(t("srv.saving"));
    try {
      const saved = await api("/api/servers", { method: "POST", body: readServer(node) });
      fillServer(node, saved);
      say(t("srv.saved"), "ok");
    } catch (e) { say(`${t("srv.error")}: ${e.message}`, "err"); }
  });
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
