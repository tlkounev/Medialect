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
    const across = dx ? Math.abs(cb.y - ca.y) : Math.abs(cb.x - ca.x);   // sideways offset
    const overlap = dx ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) : Math.min(a.right, b.right) - Math.max(a.left, b.left);
    // sideways moves stay in the same row whenever the row has something; up/down prefer the same column
    const score = Math.max(edge, 0) + (overlap > 0 ? across * 0.3 : across * 2 + (dx ? 1000 : 0));
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
}

export function enableTvNavigation(): void {
  document.documentElement.classList.add("tv");
  document.addEventListener("keydown", (e) => {
    const active = document.activeElement as HTMLElement | null;
    const typing = active && (active.tagName === "TEXTAREA" || (active.tagName === "INPUT" &&
      !["checkbox", "radio", "button", "submit"].includes((active as HTMLInputElement).type)));
    if (e.key in DIRS) {
      // inside a text field, left/right move the cursor; up/down leave the field
      if (typing && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;
      const [dx, dy] = DIRS[e.key];
      const target = next(active && active !== document.body ? active : null, dx, dy);
      if (target) {
        e.preventDefault();
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
      }
      return;
    }
    if (e.key === "Enter" && active && active.tagName === "INPUT" && ["checkbox", "radio"].includes((active as HTMLInputElement).type)) {
      e.preventDefault();
      active.click();
    }
  }, true);
  // start with something focused so the first press of an arrow does something visible
  setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) next(null, 0, 1)?.focus(); }, 800);
}
