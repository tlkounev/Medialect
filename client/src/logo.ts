// Service logos in the catalogue: every logo the same visual size.
// The icons come with different empty margins (a small wordmark in the middle of a big tile, or a logo that
// fills the whole tile). The logo is cut out of its background and drawn again, centred, on a tile of the
// same background colour, filling the same share of the tile.
import { env } from "./core/env";

export const TILE = 96;        // output size (shown at 32 px, sharp on 3x screens)
export const FILL = 0.74;      // the logo's longer side takes this share of the tile
const TOLERANCE = 48;          // colour distance that still counts as background
const VERSION = 1;             // bump when the processing changes: cached logos are made again

export interface Box { x: number; y: number; w: number; h: number }
export interface Analysis { bg: [number, number, number, number]; box: Box | null }

const dist = (d: Uint8ClampedArray, i: number, c: number[]) =>
  Math.abs(d[i] - c[0]) + Math.abs(d[i + 1] - c[1]) + Math.abs(d[i + 2] - c[2]);

/** Background = the most common colour along the edges (transparent when most edge pixels are). */
export function analyse(d: Uint8ClampedArray, w: number, h: number): Analysis {
  const counts = new Map<string, [number, number[]]>();
  let transparent = 0, edge = 0;
  const visit = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    edge++;
    if (d[i + 3] < 128) { transparent++; return; }
    const key = `${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`;
    const e = counts.get(key);
    if (e) e[0]++; else counts.set(key, [1, [d[i], d[i + 1], d[i + 2]]]);
  };
  for (let x = 0; x < w; x++) { visit(x, 0); visit(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { visit(0, y); visit(w - 1, y); }
  let best: [number, number[]] | null = null;
  for (const e of counts.values()) if (!best || e[0] > best[0]) best = e;
  const clear = transparent > edge / 2 || !best;
  const bg: [number, number, number, number] = clear ? [0, 0, 0, 0] : [best![1][0], best![1][1], best![1][2], 255];

  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const content = clear ? d[i + 3] >= 128 : d[i + 3] >= 128 && dist(d, i, bg) > TOLERANCE;
      if (content) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  return { bg, box: x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
}

/** Where the cut-out logo goes on the output tile. */
export function placement(box: Box): Box {
  const scale = (TILE * FILL) / Math.max(box.w, box.h);
  const w = box.w * scale, h = box.h * scale;
  return { x: (TILE - w) / 2, y: (TILE - h) / 2, w, h };
}

async function render(url: string): Promise<string> {
  const r = await env.fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const bmp = await createImageBitmap(await r.blob());
  const src = document.createElement("canvas");
  src.width = bmp.width; src.height = bmp.height;
  const sctx = src.getContext("2d", { willReadFrequently: true })!;
  sctx.drawImage(bmp, 0, 0);
  const { bg, box } = analyse(sctx.getImageData(0, 0, bmp.width, bmp.height).data, bmp.width, bmp.height);
  const out = document.createElement("canvas");
  out.width = out.height = TILE;
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  if (bg[3]) { ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`; ctx.fillRect(0, 0, TILE, TILE); }
  const b = box || { x: 0, y: 0, w: bmp.width, h: bmp.height };
  const p = placement(b);
  ctx.drawImage(bmp, b.x, b.y, b.w, b.h, p.x, p.y, p.w, p.h);
  return out.toDataURL("image/png");
}

const memo = new Map<string, Promise<string>>();

/** Normalised logo as a data URL; kept in the database, so each logo is processed once. */
export function logo(url: string): Promise<string> {
  let p = memo.get(url);
  if (!p) {
    const key = `logo:${VERSION}:${url}`;
    p = (async () => {
      const cached = await env.db.kvGet<string | null>(key, null);
      if (cached) return cached;
      const made = await render(url);
      await env.db.kvSet(key, made);
      return made;
    })();
    p.catch(() => memo.delete(url));   // a server that was unreachable is tried again next time
    memo.set(url, p);
  }
  return p;
}
