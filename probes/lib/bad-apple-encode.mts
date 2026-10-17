// The Bad Apple encoder (TrigScript 4, S4): greyscale frames (128 × 96, one byte a pixel, one frame per game frame)
// into brushes — the game's sight shapes — whose union is the frame's light part.
//
//   npx tsx probes/lib/bad-apple-encode.mts <frames.gray> <out.bin> [workers]
//
// out.bin: per frame a u16 count, then count × u32 (x | y << 8 | size << 16); size 0 is the ground 3 × 3 (a ground
// unit at sight 0), 1–11 the air shapes (probes/lib/fog-masks.json, measured in the lifted game). The board is the
// map's top 96 rows; the rows below it must stay dark, the map's own edges clip. Played in Remastered 2026-10-17:
// each size its own unit type, sights never changed within a pass (a sight write reaches the game a frame late).
//
// Two passes a frame: an exact cover (greedy, largest new area first, never lighting a dark pixel), then every light
// pixel still uncovered — a line thinner than three tiles — gets a 3 × 3 anyway, so it is drawn a tile too thick
// instead of not at all.
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

export const W = 128, H = 96, MARGIN = 2;
const air: Record<string, [number, number][]> = JSON.parse(readFileSync(new URL("./fog-masks.json", import.meta.url), "utf8"));
const GROUND: [number, number][] = [];
for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) GROUND.push([dx, dy]);
export const MASKS: [number, number][][] = [GROUND, ...Array.from({ length: 11 }, (_, i) => air[String(i + 1)])];

/** Each mask as tile offsets, with its rows clipped to the map the way the game clips them. */
const OFFS = MASKS.map((m) => m.map(([dx, dy]) => [dx, dy] as const));

/** Whether a brush lights only light tiles and nothing below the board (off the map's own edges, the game clips it). */
function fits(white: Uint8Array, size: number, x: number, y: number): boolean {
  for (const [dx, dy] of OFFS[size]) {
    const X = x + dx, Y = y + dy;
    if (X < 0 || X >= W || Y < 0) continue;
    if (Y >= H || !white[Y * W + X]) return false;
  }
  return true;
}

function gain(covered: Uint8Array, size: number, x: number, y: number): number {
  let g = 0;
  for (const [dx, dy] of OFFS[size]) { const X = x + dx, Y = y + dy; if (X >= 0 && X < W && Y >= 0 && Y < H && !covered[Y * W + X]) g++; }
  return g;
}

export function encodeFrame(white: Uint8Array): number[] {
  const covered = new Uint8Array(W * H);
  const chosen: number[] = [];
  let left = 0;
  for (let i = 0; i < W * H; i++) left += white[i];
  if (left) {
    // A binary max-heap of (gain, word). Lazy greedy: a gain only ever falls, so a popped candidate whose fresh gain
    // still beats the new head is the best there is; otherwise it goes back with its fresh gain.
    let n = 0;
    const gains = new Int32Array(MASKS.length * W * H), words = new Int32Array(MASKS.length * W * H);
    const swap = (a: number, b: number) => { const g = gains[a], w = words[a]; gains[a] = gains[b]; words[a] = words[b]; gains[b] = g; words[b] = w; };
    const up = (i: number) => { while (i > 0) { const p = (i - 1) >> 1; if (gains[p] >= gains[i]) break; swap(p, i); i = p; } };
    const down = (i: number) => { for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < n && gains[l] > gains[m]) m = l; if (r < n && gains[r] > gains[m]) m = r; if (m === i) break; swap(m, i); i = m; } };
    const push = (g: number, w: number) => { gains[n] = g; words[n] = w; up(n++); };
    const pop = () => { n--; swap(0, n); down(0); };
    for (let size = 0; size < MASKS.length; size++) for (let y = MARGIN; y < H - MARGIN; y++) for (let x = MARGIN; x < W - MARGIN; x++)
      if (fits(white, size, x, y)) { const g = gain(covered, size, x, y); if (g) push(g, x | (y << 8) | (size << 16)); }
    while (n && left) {
      const w = words[0], x = w & 0xff, y = (w >> 8) & 0xff, size = w >> 16;
      const g = gain(covered, size, x, y);
      pop();
      if (g === 0) continue;
      if (n && g < gains[0]) { push(g, w); continue; }
      chosen.push(w);
      for (const [dx, dy] of OFFS[size]) { const X = x + dx, Y = y + dy; if (X >= 0 && X < W && Y >= 0 && Y < H && !covered[Y * W + X]) { covered[Y * W + X] = 1; left--; } }
    }
  }
  // Thin light lines: a 3 × 3 on each light tile still dark, darks be lit.
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!white[i] || covered[i]) continue;
    const cx = Math.min(W - 1 - MARGIN, Math.max(MARGIN, x)), cy = Math.min(H - 2, Math.max(MARGIN, y));
    chosen.push(cx | (cy << 8));
    for (const [dx, dy] of GROUND) { const X = cx + dx, Y = cy + dy; if (X >= 0 && X < W && Y >= 0 && Y < H) covered[Y * W + X] = 1; }
  }
  // Grouped by size: one EUDSwitch case after another in the game, and the table reads in order.
  return chosen.sort((a, b) => (a >> 16) - (b >> 16));
}

/** What a frame's brushes light, as the game would (for the checks). */
export function lights(words: number[]): Uint8Array {
  const out = new Uint8Array(W * H);
  for (const w of words) {
    const x = w & 0xff, y = (w >> 8) & 0xff, size = w >> 16;
    for (const [dx, dy] of MASKS[size]) { const X = x + dx, Y = y + dy; if (X >= 0 && X < W && Y >= 0 && Y < H) out[Y * W + X] = 1; }
  }
  return out;
}

export function readFrames(path: string, threshold = 128): Uint8Array[] {
  const raw = readFileSync(path), n = Math.floor(raw.length / (W * H)), out: Uint8Array[] = [];
  for (let k = 0; k < n; k++) { const f = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) f[i] = raw[k * W * H + i] >= threshold ? 1 : 0; out.push(f); }
  return out;
}

export function pack(frames: number[][]): Buffer {
  const parts: Buffer[] = [];
  for (const f of frames) { const b = Buffer.alloc(2 + 4 * f.length); b.writeUInt16LE(f.length, 0); f.forEach((w, i) => b.writeUInt32LE(w, 2 + 4 * i)); parts.push(b); }
  return Buffer.concat(parts);
}

export function unpack(buf: Buffer): number[][] {
  const out: number[][] = [];
  for (let at = 0; at < buf.length;) { const n = buf.readUInt16LE(at); at += 2; const f: number[] = []; for (let i = 0; i < n; i++, at += 4) f.push(buf.readUInt32LE(at)); out.push(f); }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, output, workersArg] = process.argv.slice(2);
  const range = process.env.BA_RANGE;
  const frames = readFrames(input);
  if (range) {
    // A worker: its share of the frames, packed, to the file it was given.
    const [from, to] = range.split(",").map(Number);
    writeFileSync(output, pack(frames.slice(from, to).map(encodeFrame)));
  } else {
    const workers = Number(workersArg ?? 12), per = Math.ceil(frames.length / workers), t0 = Date.now();
    await Promise.all(Array.from({ length: workers }, (_, w) => new Promise<void>((done, fail) => {
      const p = spawn(process.execPath, [...process.execArgv, process.argv[1], input, `${output}.part${w}`], { env: { ...process.env, BA_RANGE: `${w * per},${Math.min(frames.length, (w + 1) * per)}` }, stdio: "inherit" });
      p.on("exit", (code) => (code === 0 ? done() : fail(new Error(`worker ${w} exited ${code}`))));
    })));
    const all = Array.from({ length: workers }, (_, w) => unpack(readFileSync(`${output}.part${w}`))).flat();
    writeFileSync(output, pack(all));
    let brushes = 0, max = 0, wrong = 0, light = 0;
    all.forEach((f, k) => { brushes += f.length; max = Math.max(max, f.length); const l = lights(f); for (let i = 0; i < W * H; i++) { if (l[i] !== frames[k][i]) wrong++; light += frames[k][i]; } });
    console.log(`${all.length} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s; brushes ${brushes} (${(brushes / all.length).toFixed(1)} a frame, ${max} at most); ${wrong} tiles wrong of ${all.length * W * H} (${(100 * wrong / (all.length * W * H)).toFixed(2)}%), ${(100 * light / (all.length * W * H)).toFixed(1)}% light; table ${(brushes * 4 + all.length * 2) / 1e6} MB`);
  }
}
