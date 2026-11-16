// Remote-control (D-pad) navigation for Google TV / Android TV: arrows move focus to the nearest
// visible control in that direction, OK activates it. Only active on devices without a touchscreen.

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea, [tabindex]:not([tabindex='-1'])";
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

/** Best candidate in direction (dx, dy): mostly in line, then nearest. */
function next(from: Element | null, dx: number, dy: number): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => e !== from && visible(e));
  if (!from || !visible(from)) return all[0] || null;
  const a = from.getBoundingClientRect(), ca = center(a);
  let best: HTMLElement | null = null, bestScore = Infinity;
  for (const el of all) {
    const b = el.getBoundingClientRect(), cb = center(b);
    const along = dx ? (cb.x - ca.x) * dx : (cb.y - ca.y) * dy;            // distance in the wanted direction
    const edge = dx ? (dx > 0 ? b.left - a.right : a.left - b.right) : (dy > 0 ? b.top - a.bottom : a.top - b.bottom);
    if (along <= 0 || edge < -Math.min(a.width, a.height) / 2) continue;
    // sideways offset: from our centre to the nearest point of the candidate (a wide field right above counts as 0)
    const across = dx ? Math.max(b.top - ca.y, ca.y - b.bottom, 0) : Math.max(b.left - ca.x, ca.x - b.right, 0);
    const overlap = dx ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) : Math.min(a.right, b.right) - Math.max(a.left, b.left);
    // sideways moves stay in the same row whenever the row has something; up/down prefer the same column
    const score = Math.max(edge, 0) + (overlap > 0 ? across * 0.3 : across * 2 + (dx ? 1000 : 0));
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
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

function move(target: HTMLElement, dy: number): void {
  target.focus({ preventScroll: true });
  // vertical moves keep the target in the middle so headings and the rows around it stay visible
  target.scrollIntoView({ block: dy ? "center" : "nearest", inline: "nearest", behavior: "smooth" });
}

export function enableTvNavigation(): void {
  document.documentElement.classList.add("tv");
  lockAll();
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
  // start with something focused so the first press of an arrow does something visible
  setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) next(null, 0, 1)?.focus(); }, 800);
}
