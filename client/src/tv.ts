// Remote-control (D-pad) navigation for Google TV / Android TV: arrows move focus to the nearest
// visible control in that direction, OK activates it. Only active on devices without a touchscreen.
// Catalogue: a title is one stop; OK on it steps inside to its streams (down goes stream by stream,
// past the last one to the next title). Up/down always land on the leftmost control of the next row.

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea, [tabindex]:not([tabindex='-1'])";
const SKIP = "#home, #home *, .rating";         // the logo is not a button on TV, ratings are not stops
const DIRS: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

export function isTv(): boolean {
  return /Android/i.test(navigator.userAgent) && navigator.maxTouchPoints === 0;
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const s = getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none" && !(el as HTMLElement).closest(".hidden");
}

function center(r: DOMRect) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

/** Inside a title only its own controls of an opened title count; a closed title is one stop itself. */
function stop(el: HTMLElement): boolean {
  if (el.matches(SKIP) || !visible(el)) return false;
  const title = el.closest(".title");
  if (!title) return true;
  return el === title ? !title.classList.contains("tv-in") : title.classList.contains("tv-in");
}
function candidates(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`${FOCUSABLE}, #catalog .title`)].filter(stop);
}

/** Where focus starts on a page: the topmost title in view in the catalogue, else the page's first control. */
function startTarget(): HTMLElement | null {
  const page = [...document.querySelectorAll<HTMLElement>("main > section")].find((s) => !s.classList.contains("hidden"));
  if (!page) return null;
  const top = document.querySelector("header")?.getBoundingClientRect().bottom || 0;
  const titles = [...page.querySelectorAll<HTMLElement>("#catalog .title")].filter(visible);
  if (titles.length) return titles.find((t) => t.getBoundingClientRect().bottom > top + 40) || titles[0];
  if (page.id === "tab-catalog") return null;          // titles not loaded yet
  return candidates().find((el) => page.contains(el)) || null;
}

/** Best candidate in direction (dx, dy). Sideways: mostly in line, then nearest.
 *  Up/down: the nearest row in that direction, and in it the control furthest left (right in RTL). */
function next(from: Element | null, dx: number, dy: number): HTMLElement | null {
  const all = candidates().filter((e) => e !== from);
  if (!from || !visible(from)) return startTarget() || all[0] || null;
  const a = from.getBoundingClientRect(), ca = center(a);
  let best: HTMLElement | null = null, bestScore = Infinity;
  for (const el of all) {
    const b = el.getBoundingClientRect(), cb = center(b);
    const along = dx ? (cb.x - ca.x) * dx : (cb.y - ca.y) * dy;            // distance in the wanted direction
    const edge = dx ? (dx > 0 ? b.left - a.right : a.left - b.right) : (dy > 0 ? b.top - a.bottom : a.top - b.bottom);
    if (along <= 0 || edge < -Math.min(a.width, a.height) / 2) continue;
    if (dx && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) <= 0) continue;   // sideways only within the row
    // sideways offset: from our centre to the nearest point of the candidate (a wide field right above counts as 0)
    const across = dx ? Math.max(b.top - ca.y, ca.y - b.bottom, 0) : Math.max(b.left - ca.x, ca.x - b.right, 0);
    const overlap = dx ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) : Math.min(a.right, b.right) - Math.max(a.left, b.left);
    // sideways moves stay in the same row whenever the row has something; up/down prefer the same column
    const score = Math.max(edge, 0) + (overlap > 0 ? across * 0.3 : across * 2 + (dx ? 1000 : 0));
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (!best || dx) return best;
  // the row of the nearest control: everything crossing the middle line of the closest one in that direction
  const ahead = all.filter((el) => {
    const b = el.getBoundingClientRect();
    return dy > 0 ? b.top >= a.top + 1 && b.top >= a.bottom - Math.min(a.height, b.height) / 2
                  : b.bottom <= a.bottom - 1 && b.bottom <= a.top + Math.min(a.height, b.height) / 2;
  });
  if (!ahead.length) return best;
  const near = ahead.reduce((m, el) => {
    const b = el.getBoundingClientRect(), r = m.getBoundingClientRect();
    return (dy > 0 ? b.top < r.top : b.bottom > r.bottom) ? el : m;
  });
  const n = near.getBoundingClientRect(), mid = n.top + n.height / 2;
  const row = ahead.filter((el) => { const b = el.getBoundingClientRect(); return b.top <= mid && b.bottom >= mid; });
  const rtl = document.dir === "rtl";
  return row.reduce((m, el) => {
    const b = el.getBoundingClientRect(), r = m.getBoundingClientRect();
    return (rtl ? b.right > r.right : b.left < r.left) ? el : m;
  }, row[0]);
}

const TEXT_TYPES = ["text", "search", "number", "password", "email", "url", "tel", ""];
const isText = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement =>
  !!el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && TEXT_TYPES.includes((el as HTMLInputElement).type)));

// Text fields stay read-only while the remote moves over them, so Android does not pop up the keyboard;
// OK unlocks the focused field and only then the keyboard opens. Leaving the field locks it again.
function lock(el: Element | null): void {
  if (isText(el) && !el.dataset.tvEdit) { el.readOnly = true; el.dataset.tvLock = "1"; }
}
function lockAll(root: ParentNode = document): void {
  root.querySelectorAll("input, textarea").forEach((el) => lock(el));
}
function unlock(el: HTMLInputElement | HTMLTextAreaElement): void {
  el.dataset.tvEdit = "1";
  el.readOnly = false;
  el.blur();
  el.focus();                       // re-focus as an editable field: now Android shows the keyboard
  el.click();
}

function focusStart(tries = 25): void {
  const el = startTarget();
  if (el) el.focus({ preventScroll: true });
  else if (tries) setTimeout(() => focusStart(tries - 1), 200);
  else candidates()[0]?.focus({ preventScroll: true });
}
const lost = () => { const a = document.activeElement; return !a || a === document.body || !visible(a); };

function move(target: HTMLElement, dy: number): void {
  target.focus({ preventScroll: true });
  // vertical moves keep the target in the middle so headings and the rows around it stay visible
  target.scrollIntoView({ block: dy ? "center" : "nearest", inline: "nearest", behavior: "smooth" });
}

export function enableTvNavigation(): void {
  document.documentElement.classList.add("tv");
  for (const el of document.querySelectorAll<HTMLElement>("#home, #home a")) el.tabIndex = -1;
  lockAll();
  // titles can take focus (not in the Tab order); a title left by the focus closes again
  const titles = (root: ParentNode) => root.querySelectorAll<HTMLElement>(".title:not([tabindex])").forEach((t) => { t.tabIndex = -1; });
  titles(document);
  new MutationObserver(() => titles(document)).observe(document.body, { childList: true, subtree: true });
  document.addEventListener("focusin", (e) => {
    for (const t of document.querySelectorAll(".title.tv-in")) if (!t.contains(e.target as Node)) t.classList.remove("tv-in");
  });
  // a page shown again (settings -> catalogue) or a list drawn again: focus its first title / control
  let lastId = "";
  document.addEventListener("focusin", (e) => { lastId = (e.target as Element).closest?.<HTMLElement>(".title")?.dataset.id || lastId; });
  const regain = () => setTimeout(() => {
    if (!lost()) return;
    const same = lastId && document.querySelector<HTMLElement>(`#catalog .title[data-id="${CSS.escape(lastId)}"]`);
    if (same && visible(same)) same.focus({ preventScroll: true }); else focusStart();
  }, 50);
  document.querySelectorAll("main > section").forEach((sec) =>
    new MutationObserver(() => { if (!sec.classList.contains("hidden")) { lastId = ""; regain(); } }).observe(sec, { attributes: true, attributeFilter: ["class"] }));
  const cat = document.getElementById("catalog");
  if (cat) new MutationObserver(regain).observe(cat, { childList: true });
  // the keyboard shrinks the page: keep the field being typed in above it
  addEventListener("resize", () => {
    const a = document.activeElement as HTMLElement | null;
    if (isText(a) && !a.readOnly) setTimeout(() => a.scrollIntoView({ block: "center", behavior: "smooth" }), 50);
  });
  new MutationObserver((recs) => recs.forEach((r) => r.addedNodes.forEach((n) => {
    if (n instanceof Element) { lock(n); lockAll(n); }
  }))).observe(document.body, { childList: true, subtree: true });
  document.addEventListener("focusin", (e) => lock(e.target as Element), true);
  document.addEventListener("focusout", (e) => {
    const el = e.target as HTMLElement;
    if (isText(el) && el.dataset.tvEdit) {
      setTimeout(() => { if (document.activeElement !== el) { delete el.dataset.tvEdit; lock(el); } }, 0);
    }
  }, true);

  document.addEventListener("keydown", (e) => {
    const active = document.activeElement as HTMLElement | null;
    const editing = isText(active) && !active.readOnly;
    // the service picker moves a tile with the arrows itself
    if (active?.closest("#jwProviders")?.querySelector(".svc.moving")) return;
    if (e.key === "Enter" && active?.matches("#catalog .title:not(.tv-in)")) {
      // OK on a title steps inside, to its first stream
      e.preventDefault();
      const first = active.querySelector<HTMLElement>(".offer-main, .offer .more");
      if (first) { active.classList.add("tv-in"); first.focus({ preventScroll: true }); }
      return;
    }
    if (e.key in DIRS) {
      // while typing, left/right move the cursor; up/down leave the field
      if (editing && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;
      const [dx, dy] = DIRS[e.key];
      const target = next(active && active !== document.body ? active : null, dx, dy);
      e.preventDefault();
      if (editing) active!.blur();
      if (target) move(target, dy);
      else if (dy) window.scrollBy({ top: dy * window.innerHeight * 0.6, behavior: "smooth" });   // reveal headings at the edges
      if (target && dy < 0 && !next(target, 0, -1)) window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (e.key === "Enter" && isText(active) && active.readOnly && active.dataset.tvLock) {
      e.preventDefault();
      unlock(active);
      return;
    }
    if ((e.key === "Escape" || e.key === "GoBack") && editing) { active!.blur(); return; }
    if (e.key === "Enter" && active && active.tagName === "INPUT" && ["checkbox", "radio"].includes((active as HTMLInputElement).type)) {
      e.preventDefault();
      active.click();
    }
  }, true);
  // start on the first title under the search field
  setTimeout(() => { if (lost() || document.activeElement?.id === "q") focusStart(); }, 300);
}
