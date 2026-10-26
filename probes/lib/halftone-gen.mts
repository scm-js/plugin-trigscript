// The halftone probe's pictures (probes/halftone.ts): made here, not imported from anyone's files, so they are ours.
//
//   npx tsx probes/lib/halftone-gen.mts
//
// Writes into probes/: halftone-ramp.image (black to white, left to right), halftone-scene.image (a lit ball over a
// floor lightening towards the eye: large shapes in every grey, a soft shadow), and five walks down the raycaster's
// maze rendered with each wall's grey by its distance and side — halftone-walk-flat.video (walls lit whole, today's
// look without the outline), -walk-4.video and -walk-6.video (halftones of 4 × 5 and 6 × 7 cells), -walk-4-even and
// -walk-6-even (the same without diffusion: dots that stay put as the walls move). Says how many brushes each frame
// of each takes, against the game's ~800 a frame.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeImage, writeImage } from "../../compiler/image";
import { writeVideo } from "../../compiler/media";
import { cover, prepareShapes } from "../../compiler/cover";
import { FOG_SHAPES } from "../../compiler/fogShapes";

const OUT = join(import.meta.dirname, "..");
/** The board: the map's top 96 rows less two tiles all round (a brush's centre at the very edge is pushed inward). */
const W = 124, H = 92;

const greyImage = (w: number, h: number, g: (x: number, y: number) => number) => {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.max(0, Math.min(255, Math.round(g(x, y)))), i = (y * w + x) * 4;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
    rgba[i + 3] = 255;
  }
  return { width: w, height: h, rgba };
};

// The ramp: one band the board's width, cropped by the script to each cell's height.
const RAMP_H = 28;
writeFileSync(join(OUT, "halftone-ramp.image"), writeImage({ ...greyImage(W, RAMP_H, (x) => (x / (W - 1)) * 255), source: "halftone-gen.mts" }));

// The scene: large shapes in every grey, nothing finer than a cell — a sky darkening upwards, a floor lightening
// towards the eye, a ball lit from the upper left with its shadow on the floor.
const HORIZON = 38, BALL = { x: 62, y: 44, r: 30 };
const scene = greyImage(W, H, (x, y) => {
  const dx = (x - BALL.x) / BALL.r, dy = (y - BALL.y) / BALL.r;
  if (dx * dx + dy * dy <= 1) {
    const dz = Math.sqrt(1 - dx * dx - dy * dy);
    // Lambert, the light from up, left and towards the eye.
    return 255 * Math.max(0, -0.55 * dx - 0.55 * dy + 0.63 * dz);
  }
  if (y < HORIZON) return 20 + (y / HORIZON) * 120;
  const sx = (x - BALL.x - 12) / 40, sy = (y - (BALL.y + BALL.r + 2)) / 8;
  const shadow = Math.max(0, 1 - Math.sqrt(sx * sx + sy * sy));
  return (110 + ((y - HORIZON) / (H - HORIZON)) * 140) * (1 - 0.85 * shadow);
});
writeFileSync(join(OUT, "halftone-scene.image"), writeImage({ ...scene, source: "halftone-gen.mts" }));

// The walk: the raycaster's maze (probes/raycaster.ts), the shortest way from the start towards the way out.
const MAZE = [
  "################",
  "#......#.......#",
  "#.##...#..#.#..#",
  "#.##......#.#..#",
  "#......#.......#",
  "###.####.###.###",
  "#..............#",
  "#.#.#.#..#.#.#.#",
  "#..............#",
  "####.###.##.####",
  "#......#.......#",
  "#.###..#..###..#",
  "#.#..........#.#",
  "#.#.###..##..#.#",
  "#......#.....#.E",
  "################",
];
const N = MAZE.length;
const wall = (x: number, y: number) => MAZE[y]?.[x] !== ".";
const path = (() => {
  const from = new Map<number, number>([[1 * N + 1, -1]]), queue = [1 * N + 1];
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q], cx = c % N, cy = Math.floor(c / N);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = (cy + dy) * N + cx + dx;
      if (!from.has(n) && (MAZE[cy + dy][cx + dx] === "." || MAZE[cy + dy][cx + dx] === "E")) { from.set(n, c); queue.push(n); }
    }
  }
  const out: [number, number][] = [];
  for (let c = 14 * N + 15; c !== -1; c = from.get(c)!) out.unshift([c % N + 0.5, Math.floor(c / N) + 0.5]);
  return out;
})();

/** Each frame's camera: walking the path's cells at a steady pace, turning on the spot at a corner. */
function cameras(count: number): { x: number; y: number; a: number }[] {
  const out: { x: number; y: number; a: number }[] = [];
  let [x, y] = path[0], next = 1, a = Math.atan2(path[1][1] - y, path[1][0] - x);
  while (out.length < count && next < path.length) {
    const [tx, ty] = path[next], want = Math.atan2(ty - y, tx - x);
    let turn = want - a;
    while (turn > Math.PI) turn -= 2 * Math.PI;
    while (turn < -Math.PI) turn += 2 * Math.PI;
    if (Math.abs(turn) > 0.02) a += Math.sign(turn) * Math.min(Math.abs(turn), 0.07);
    else {
      const d = Math.hypot(tx - x, ty - y), step = 0.06;
      if (d <= step) { x = tx; y = ty; next++; } else { x += ((tx - x) / d) * step; y += ((ty - y) / d) * step; }
    }
    out.push({ x, y, a });
  }
  return out;
}

/** One frame: a column a tile, each wall's grey by how far it is and which way it faces; ceiling and floor dark. */
function render(cam: { x: number; y: number; a: number }): Uint8Array {
  const g = new Uint8Array(W * H);
  const dirX = Math.cos(cam.a), dirY = Math.sin(cam.a), FOV = 0.66, planeX = -dirY * FOV, planeY = dirX * FOV;
  for (let col = 0; col < W; col++) {
    const c = (2 * col) / W - 1, rx = dirX + planeX * c, ry = dirY + planeY * c;
    let mx = Math.floor(cam.x), my = Math.floor(cam.y);
    const ddx = Math.abs(1 / rx), ddy = Math.abs(1 / ry), sx = rx < 0 ? -1 : 1, sy = ry < 0 ? -1 : 1;
    let sdx = (rx < 0 ? cam.x - mx : mx + 1 - cam.x) * ddx, sdy = (ry < 0 ? cam.y - my : my + 1 - cam.y) * ddy, side = 0;
    for (let k = 0; k < 64; k++) {
      if (sdx < sdy) { sdx += ddx; mx += sx; side = 0; } else { sdy += ddy; my += sy; side = 1; }
      if (wall(mx, my)) break;
    }
    const dist = Math.max(0.05, side === 0 ? sdx - ddx : sdy - ddy);
    const height = Math.min(H, Math.round(H / dist / 0.9));
    const grey = Math.max(0.12, Math.min(1, 1.15 - dist / 7)) * (side ? 0.62 : 1) * 255;
    for (let y = (H - height) >> 1, end = y + height; y < end; y++) g[y * W + col] = grey;
  }
  return g;
}

const FRAMES = 300;
const shapes = prepareShapes(FOG_SHAPES);
const views = cameras(FRAMES).map(render);
const toImage = (g: Uint8Array) => makeImage({ width: W, height: H, color: false, alpha: false, rgba: Uint8Array.from({ length: W * H * 4 }, (_, i) => ((i & 3) === 3 ? 255 : g[i >> 2])) });
const tilesOf = (rows: readonly string[]) => Uint8Array.from(rows.join(""), (c) => (c === "#" ? 1 : 0));
const variants: [string, (g: Uint8Array) => Uint8Array][] = [
  ["flat", (g) => g.map((v) => (v > 0 ? 1 : 0))],
  ["4", (g) => tilesOf(toImage(g).halftone(4))],
  ["4-even", (g) => tilesOf(toImage(g).halftone(4, 5, { diffuse: false }))],
  ["6", (g) => tilesOf(toImage(g).halftone(6))],
  ["6-even", (g) => tilesOf(toImage(g).halftone(6, 7, { diffuse: false }))],
];
for (const [name, make] of variants) {
  const frames = views.map(make);
  const counts = frames.map((f) => cover(f, W, H, shapes).length);
  writeFileSync(join(OUT, `halftone-walk-${name}.video`), writeVideo({ width: W, height: H, frameMs: 42, frames, source: "halftone-gen.mts" }));
  console.log(`walk ${name}: ${frames.length} frames, brushes a frame ${Math.round(counts.reduce((a, b) => a + b, 0) / counts.length)} on average, ${Math.max(...counts)} at most`);
}
for (const [name, rows] of [["ramp 4", makeImage({ width: W, height: RAMP_H, color: false, alpha: false, rgba: greyImage(W, RAMP_H, (x) => (x / (W - 1)) * 255).rgba }).halftone(4)], ["scene 4", toImage(Uint8Array.from({ length: W * H }, (_, i) => scene.rgba[i * 4])).halftone(4)], ["scene 6", toImage(Uint8Array.from({ length: W * H }, (_, i) => scene.rgba[i * 4])).halftone(6)], ["scene 8", toImage(Uint8Array.from({ length: W * H }, (_, i) => scene.rgba[i * 4])).halftone(8)]] as const) {
  console.log(`${name}: ${(rows as unknown as { brushes: unknown[] }).brushes.length} brushes`);
}
