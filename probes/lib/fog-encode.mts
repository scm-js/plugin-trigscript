// The fog encoder (TrigScript 4, S4): the masks are the game's air sight shapes, sight 1 to 11, measured in the lifted
// game (a flyer's sight 0 reveals nothing). Greedy cover of a frame's white (visible) pixels with the game's air sight masks, never touching a black pixel.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(process.env.HOME + "/github/scm-js/package.json");
const sharp = require("sharp");
const masks: Record<string, [number, number][]> = JSON.parse(readFileSync(new URL("./fog-masks.json", import.meta.url), "utf8"));
const W = 128, H = 96;
export async function frameFromSvg(svg: string): Promise<Uint8Array> {
  const { data } = await sharp(Buffer.from(svg)).resize(W, H).greyscale().raw().toBuffer({ resolveWithObject: true });
  const out = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) out[i] = data[i] > 127 ? 1 : 0; return out;
}
/** Brush centres stay `margin` tiles inside the map: a unit made on the last rows is moved inward to fit (lifted game, 2026-10-17). */
export function cover(white: Uint8Array, radii = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], margin = 2) {
  const cands: { r: number; x: number; y: number; cells: number[] }[] = [];
  for (const r of radii) for (let y = margin; y < H - margin; y++) for (let x = margin; x < W - margin; x++) {
    const cells: number[] = []; let ok = true;
    for (const [dx, dy] of masks[r]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= W || Y >= H) continue; const i = Y * W + X; if (!white[i]) { ok = false; break; } cells.push(i); }
    if (ok && cells.length) cands.push({ r, x, y, cells });
  }
  const covered = new Uint8Array(W * H); const chosen: typeof cands = [];
  // lazy greedy
  const gain = (c: (typeof cands)[0]) => { let g = 0; for (const i of c.cells) if (!covered[i]) g++; return g; };
  const heap = cands.map((c) => ({ c, g: c.cells.length })).sort((a, b) => b.g - a.g);
  while (heap.length) {
    const top = heap[0]; const g = gain(top.c);
    if (g === 0) { heap.shift(); continue; }
    if (heap.length > 1 && g < heap[1].g) { top.g = g; heap.shift(); let lo = 0, hi = heap.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (heap[mid].g > g) lo = mid + 1; else hi = mid; } heap.splice(lo, 0, top); continue; }
    heap.shift(); chosen.push(top.c); for (const i of top.c.cells) covered[i] = 1;
  }
  let whites = 0, missed = 0; for (let i = 0; i < W * H; i++) if (white[i]) { whites++; if (!covered[i]) missed++; }
  return { chosen, covered, whites, missed };
}
export async function png(path: string, white: Uint8Array, covered: Uint8Array) {
  const S = 4, img = Buffer.alloc(W * S * 2 * H * S * 3);
  for (let y = 0; y < H * S; y++) for (let x = 0; x < W * S * 2; x++) {
    const src = x < W * S ? white : covered; const i = Math.floor(y / S) * W + Math.floor((x % (W * S)) / S);
    const v = src === white ? (white[i] ? 255 : 0) : covered[i] ? 235 : white[i] ? 200 : 70; // missed white shows as light grey
    const o = (y * W * S * 2 + x) * 3; img[o] = img[o + 1] = img[o + 2] = v; if (src !== white && white[i] && !covered[i]) { img[o] = 255; img[o + 1] = 60; img[o + 2] = 60; }
  }
  await sharp(img, { raw: { width: W * S * 2, height: H * S, channels: 3 } }).png().toFile(path);
}
