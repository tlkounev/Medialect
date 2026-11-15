"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SA_CATALOGS_CZ = ["netflix", "prime", "disney", "hbo", "apple", "skyshowtime", "curiosity", "crunchyroll", "zee5"];
const RATING_LABEL = { csfd: "ČSFD", imdb: "IMDb", rottentomatoes: "RT", rottentomatoes_audience: "RT diváci", metacritic: "Metacritic", metacritic_user: "MC uživ.", letterboxd: "Letterboxd", tmdb: "TMDB", trakt: "Trakt", mdblist: "MDBList", rogerebert: "Ebert" };
const MON_LABEL = { flatrate: "", free: "zdarma", ads: "s reklamou", addon: "doplněk", library: "" };
const QUALITY_LABEL = { UHD: "4K", QHD: "1440p", FHD: "1080p", HD: "720p", SD: "SD" };
const STATUS_LABEL = { ok: "OK", partial: "Částečně", error: "Chyba", running: "Běží", queued: "Ve frontě" };

let isAdmin = false;

async function api(path, opts = {}) {
  const init = { credentials: "same-origin", ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } };
  if (init.body && typeof init.body !== "string") init.body = JSON.stringify(init.body);
  const r = await fetch(path, init);
  if (r.status === 401 && !path.startsWith("/api/auth/")) { setAdmin(false); throw new Error("Nepřihlášen"); }
  const data = r.headers.get("content-type")?.includes("json") ? await r.json() : null;
  if (!r.ok) throw new Error(data?.detail || `HTTP ${r.status}`);
  return data;
}

/* ---------- admin login ---------- */
let authMode = "login";
async function boot() {
  const st = await api("/api/auth/state");
  authMode = st.configured ? "login" : "setup";
  $("#appVersion").textContent = st.version && st.version !== "dev" ? `v${st.version}` : "";
  setAdmin(st.logged_in, false);
  openTab(location.hash.slice(1) || "catalog");
  if (st.logged_in) pollBadge();
}
function setAdmin(logged, refresh = true) {
  isAdmin = logged;
  $("#logout").classList.toggle("hidden", !logged);
  $("#adminPanel").classList.toggle("hidden", !logged);
  $("#adminLogin").classList.toggle("hidden", logged);
  if (!logged) { $("#syncBadge").classList.add("hidden"); renderLogin(); }
  if (refresh && !$("#tab-admin").classList.contains("hidden")) openTab("admin");
}
function renderLogin() {
  const setup = authMode === "setup";
  $("#authHint").textContent = setup ? "První spuštění – nastav heslo pro administraci." : "Pro správu se přihlas.";
  $("#authPass2").classList.toggle("hidden", !setup);
  $("#authPass2").required = setup;
  $("#authBtn").textContent = setup ? "Nastavit heslo" : "Přihlásit";
}
$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#authErr").textContent = "";
  const password = $("#authPass").value;
  if (authMode === "setup" && password !== $("#authPass2").value) { $("#authErr").textContent = "Hesla se neshodují."; return; }
  try {
    await api(authMode === "setup" ? "/api/auth/setup" : "/api/auth/login", { method: "POST", body: { password } });
    $("#authPass").value = $("#authPass2").value = "";
    authMode = "login";
    setAdmin(true);
    pollBadge();
  } catch (err) { $("#authErr").textContent = err.message; }
});
$("#logout").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  setAdmin(false);
  openTab("catalog");
});

/* ---------- tabs ---------- */
let statusTimer = null, adminSub = "sync";
function openTab(name) {
  if (!$(`#tab-${name}`)) name = "catalog";
  $$("header nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$("main > section").forEach((s) => s.classList.toggle("hidden", s.id !== `tab-${name}`));
  history.replaceState(null, "", `#${name}`);
  clearInterval(statusTimer);
  if (name === "catalog") loadCatalogProviders().then(loadCatalog);
  if (name === "admin") {
    if (isAdmin) openSub(adminSub); else $("#authPass").focus();
  }
}
function openSub(name) {
  adminSub = name;
  clearInterval(statusTimer);
  $$(".subnav button").forEach((b) => b.classList.toggle("active", b.dataset.sub === name));
  $("#sub-sync").classList.toggle("hidden", name !== "sync");
  $("#sub-settings").classList.toggle("hidden", name !== "settings");
  if (name === "sync") { loadStatus(); statusTimer = setInterval(loadStatus, 5000); }
  if (name === "settings") loadSettings();
}
$$("header nav button").forEach((b) => b.addEventListener("click", () => openTab(b.dataset.tab)));
$$(".subnav button").forEach((b) => b.addEventListener("click", () => openSub(b.dataset.sub)));

/* ---------- rendering ---------- */
function renderOffer(o) {
  const tags = [];
  if (o.quality) tags.push(`<span class="tag q-${o.quality}">${QUALITY_LABEL[o.quality] || o.quality}</span>`);
  for (const v of o.video || []) tags.push(`<span class="tag ${/DV|HDR|HLG/.test(v) ? "hdr" : ""}">${esc(v)}</span>`);
  for (const a of o.audio || []) tags.push(`<span class="tag ${/Atmos|DTS:X/.test(a) ? "aud" : ""}">${esc(a)}</span>`);
  const mon = MON_LABEL[o.monetization] ?? o.monetization;
  const langs = [];
  if (o.audio_langs?.length) langs.push(`zvuk: ${o.audio_langs.join(", ")}`);
  if (o.subtitle_langs?.length) langs.push(`tit.: ${o.subtitle_langs.slice(0, 8).join(", ")}${o.subtitle_langs.length > 8 ? "…" : ""}`);
  if (o.expires_on) langs.push(`do ${o.expires_on.slice(0, 10)}`);
  return `<div class="offer ${o.kind}">
    <span class="name">${esc(o.provider_name)}</span>${mon ? `<span class="muted">${esc(mon)}</span>` : ""}
    ${tags.join("")}<span class="langs">${esc(langs.join(" · "))}</span>
    ${o.url ? `<a class="play" href="${esc(o.url)}" target="_blank" rel="noopener">Pustit ›</a>` : ""}
  </div>`;
}
function renderTitle(t) {
  const ratings = (t.ratings || []).map((r) => {
    const label = RATING_LABEL[r.source] || r.source;
    const inner = `${esc(label)} <b>${esc(r.display)}</b>`;
    return r.url ? `<a class="rating" href="${esc(r.url)}" target="_blank" rel="noopener">${inner}</a>` : `<span class="rating">${inner}</span>`;
  }).join("");
  const sub = [t.type === "movie" ? "Film" : "Seriál", t.year, t.original_title && t.original_title !== t.title ? t.original_title : null].filter(Boolean).join(" · ");
  const img = t.poster ? `<img loading="lazy" src="${esc(t.poster)}" alt="">` : `<div class="noimg"></div>`;
  return `<article class="title">${img}<div>
    <h3>${esc(t.title)}</h3><div class="sub">${esc(sub)}</div>
    <div class="ratings">${ratings}</div>
    <div class="offers">${(t.where || []).map(renderOffer).join("")}</div>
  </div></article>`;
}

/* ---------- catalog (with search) ---------- */
let cPage = 1, catalogSeq = 0, searchTimer = null;
async function loadCatalogProviders() {
  const sel = $("#cProvider"), cur = sel.value;
  const { items } = await api("/api/providers");
  sel.innerHTML = `<option value="">Všechny služby</option>` + items.map((p) => `<option value="${esc(p.provider)}">${esc(p.name)} (${p.titles})</option>`).join("");
  sel.value = cur;
}
async function loadCatalog() {
  const seq = ++catalogSeq;
  const q = $("#q").value.trim();
  const sort = $("#cSort").value;
  const params = new URLSearchParams({ page: cPage, page_size: 40, sort, order: sort === "title" ? "asc" : "desc" });
  if (q.length >= 2) params.set("q", q);
  for (const [id, key] of [["cProvider", "provider"], ["cType", "type"], ["cQuality", "min_quality"], ["cVideo", "video"], ["cAudio", "audio"], ["cLang", "lang"]]) {
    if ($(`#${id}`).value) params.set(key, $(`#${id}`).value);
  }
  try {
    const data = await api(`/api/catalog?${params}`);
    if (seq !== catalogSeq) return;
    const pages = Math.max(1, Math.ceil(data.total / data.page_size));
    $("#cInfo").textContent = `${data.total} titulů` + (data.total > data.page_size ? ` · strana ${data.page}/${pages}` : "");
    $("#catalog").innerHTML = data.items.length ? data.items.map(renderTitle).join("") : `<p class="muted">Nic nenalezeno.</p>`;
    $("#cPrev").disabled = cPage <= 1;
    $("#cNext").disabled = cPage >= pages;
    $(".pager").classList.toggle("hidden", pages <= 1);
  } catch (e) { $("#catalog").innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
$("#q").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { cPage = 1; loadCatalog(); }, 250); });
$$(".filters select").forEach((s) => s.addEventListener("change", () => { cPage = 1; loadCatalog(); }));
$("#cPrev").addEventListener("click", () => { cPage--; loadCatalog(); scrollTo(0, 0); });
$("#cNext").addEventListener("click", () => { cPage++; loadCatalog(); scrollTo(0, 0); });

/* ---------- status ---------- */
const fmtTime = (ts) => (ts ? new Date(ts * 1000).toLocaleString("cs-CZ") : "–");
const fmtDur = (sec) => { sec = Math.max(0, Math.round(sec)); const m = Math.floor(sec / 60); return m ? `${m} min ${sec % 60} s` : `${sec} s`; };
async function loadStatus() {
  const [st, stats] = await Promise.all([api("/api/sync/status"), api("/api/stats")]);
  updateSyncBadge(st);
  $("#stats").textContent = `${stats.titles} titulů · ${stats.offers} nabídek · ${stats.ratings} hodnocení · poslední plná synchronizace: ${fmtTime(st.last_full)}`;
  const now = Date.now() / 1000;
  $("#jobs").innerHTML = `<tr><th>Zdroj</th><th>Stav</th><th>Začátek</th><th>Položek</th><th>Průběh / poslední zpráva</th><th></th></tr>` +
    st.jobs.map((j) => {
      const l = j.last || {}, p = j.progress;
      const status = j.running ? "running" : j.queued ? "queued" : l.status;
      const started = p ? p.started_at : l.started_at;
      const items = p ? p.items : l.items;
      const detail = p
        ? `<b>${esc(p.phase || "…")}</b> · běží ${fmtDur(now - p.started_at)}`
        : `<pre>${esc(l.message || "")}</pre>`;
      return `<tr><td>${esc(j.label)}</td>
        <td class="st-${status || ""}">${esc(STATUS_LABEL[status] || "Zatím neběželo")}</td>
        <td>${fmtTime(started)}</td><td>${items ?? ""}</td>
        <td>${detail}</td>
        <td><button class="ghost" data-job="${esc(j.id)}" ${j.running ? "disabled" : ""}>Spustit</button></td></tr>`;
    }).join("");
  $$("#jobs button[data-job]").forEach((b) => b.addEventListener("click", async () => { await api(`/api/sync?job=${encodeURIComponent(b.dataset.job)}`, { method: "POST" }); setTimeout(loadStatus, 500); }));
  $("#budgets").textContent = `Dnes využito – Streaming Availability: ${st.budgets.sa}, ČSFD: ${st.budgets.csfd}, MDBList: ${st.budgets.mdblist}`;
}

/* header badge: visible on every tab while something synchronises */
function updateSyncBadge(st) {
  const running = st.jobs.filter((j) => j.running);
  const badge = $("#syncBadge");
  badge.classList.toggle("hidden", !running.length);
  if (running.length) {
    const queued = st.jobs.filter((j) => j.queued).length;
    badge.textContent = `⟳ ${running.map((j) => j.progress?.phase || j.label).join(" · ")}${queued ? ` (+${queued} ve frontě)` : ""}`;
  }
}
async function pollBadge() {
  if (isAdmin) {
    try { updateSyncBadge(await api("/api/sync/status")); } catch (_) { /* ignore */ }
  }
}
setInterval(pollBadge, 10000);

$("#syncBadge").addEventListener("click", () => { adminSub = "sync"; openTab("admin"); });
$("#syncAll").addEventListener("click", async () => { await api("/api/sync", { method: "POST" }); setTimeout(loadStatus, 500); });

/* ---------- settings ---------- */
let current = null;
const getPath = (o, p) => p.split(".").reduce((a, k) => a?.[k], o);
const setPath = (o, p, v) => { const ks = p.split("."); const last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; };

function addServerRow(srv = {}) {
  const node = $("#serverTpl").content.firstElementChild.cloneNode(true);
  node.dataset.id = srv.id || "";
  for (const el of $$("[data-k]", node)) {
    const v = srv[el.dataset.k];
    if (el.type === "checkbox") el.checked = v ?? true; else if (v !== undefined) el.value = v;
  }
  $(".remove", node).addEventListener("click", () => node.remove());
  $(".test", node).addEventListener("click", async () => {
    const res = $(".result", node);
    res.textContent = "Testuji…";
    try {
      const r = await api("/api/servers/test", { method: "POST", body: readServer(node) });
      res.textContent = r.ok ? `OK ${r.info.name || ""} ${r.info.version || ""}` : `Chyba: ${r.error}`;
    } catch (e) { res.textContent = `Chyba: ${e.message}`; }
  });
  $("#servers").appendChild(node);
}
function readServer(node) {
  const s = { id: node.dataset.id || undefined };
  for (const el of $$("[data-k]", node)) s[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value.trim();
  return s;
}
$("#addServer").addEventListener("click", () => addServerRow({ type: "emby" }));

async function loadJwProviders() {
  const box = $("#jwProviders");
  try {
    const { items } = await api("/api/justwatch/providers");
    const sel = new Set(current.justwatch.providers || []);
    box.innerHTML = items.map((p) => `<label title="${esc(p.monetization_types.join(", "))}"><input type="checkbox" value="${esc(p.short_name)}" ${sel.has(p.short_name) ? "checked" : ""}>${p.icon ? `<img src="${esc(p.icon)}" alt="">` : ""}${esc(p.name)}</label>`).join("");
  } catch (e) { box.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
}

async function loadSettings() {
  current = await api("/api/settings");
  const f = $("#settingsForm");
  for (const el of $$("[name]", f)) {
    const v = getPath(current, el.name);
    if (el.type === "checkbox") el.checked = !!v; else el.value = v ?? "";
  }
  $("#servers").innerHTML = "";
  current.servers.forEach(addServerRow);
  const sel = new Set(current.streaming_availability.catalogs || []);
  $("#saCatalogs").innerHTML = SA_CATALOGS_CZ.map((c) => `<label><input type="checkbox" value="${c}" ${sel.has(c) ? "checked" : ""}>${c}</label>`).join("");
  loadJwProviders();
}
$("#settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {};
  for (const el of $$("[name]", e.target)) setPath(body, el.name, el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value.trim());
  body.servers = $$("#servers .server").map(readServer);
  const jw = $$("#jwProviders input:checked").map((i) => i.value);
  if ($$("#jwProviders input").length) body.justwatch.providers = jw;
  body.streaming_availability.catalogs = $$("#saCatalogs input:checked").map((i) => i.value);
  try {
    current = await api("/api/settings", { method: "PUT", body });
    $("#saveMsg").textContent = "Uloženo.";
    loadSettings();
  } catch (err) { $("#saveMsg").textContent = err.message; }
  setTimeout(() => ($("#saveMsg").textContent = ""), 4000);
});

$("#showToken").addEventListener("click", async () => { $("#apiToken").textContent = (await api("/api/auth/token")).token; });
$("#regenToken").addEventListener("click", async () => {
  if (!confirm("Starý klíč přestane fungovat. Pokračovat?")) return;
  $("#apiToken").textContent = (await api("/api/auth/token/regenerate", { method: "POST" })).token;
});
$("#pwForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try { await api("/api/auth/password", { method: "POST", body: { old: fd.get("old"), new: fd.get("new") } }); $("#pwMsg").textContent = "Změněno."; e.target.reset(); }
  catch (err) { $("#pwMsg").textContent = err.message; }
});

boot();
