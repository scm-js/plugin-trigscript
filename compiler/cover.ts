/**
 * Covering a picture with shapes, when the script is built (TrigScript 4, B8): the brushes whose union is a picture's
 * ink, each a shape that lies on ink only. `fog.picture` and a video's frames for `fog` are drawn this way — the shapes
 * are the game's sight ranges — and a library of a renderer of its own can use it too (`cover()` in the language).
 *
 * Greedy, largest gain first: of every shape that fits on ink anywhere, the one that covers the most ink not yet
 * covered, again and again. A gain only ever falls as more is covered, so a candidate taken off the heap whose fresh
 * gain still beats the next one's stale gain is the best there is ("lazy" greedy); else it goes back with its fresh
 * gain. Ink no shape fits on (a line thinner than the smallest) gets the smallest shape centred on it anyway, which
 * covers a tile or two beside it: drawn thicker rather than not at all.
 *
 * Shapes that nest — each inside the next, the game's sight ranges do — need one candidate a tile, the largest that
 * fits there: a smaller one centred on the same tile covers a part of what the larger does, so it never gains more.
 * 128 × 96 frames of Bad Apple take a few milliseconds each; the encoder of S4's probe, which tried every size on
 * every tile and tested each tile of each, took 130.
 */

/** One shape of a cover: which of the shapes (0 is the first), centred on tile (x, y) of the picture. */
export interface CoverBrush { x: number; y: number; shape: number }

/** Shapes made ready to cover with: each as its tiles around the centre and as one run of tiles a row. */
export interface PreparedShapes {
  readonly count: number;
  /** Shape i's tiles as (dx, dy) pairs from its centre. */
  readonly cells: readonly Int16Array[];
  /** Shape i's rows as (dy, from dx, to dx) triples, the run of tiles it covers on that row. */
  readonly runs: readonly Int16Array[];
  /** Each shape is inside the next, centred alike. */
  readonly nested: boolean;
  /**
   * Of nested shapes: for shape i, the places (dx, dy) of a larger one (shape `inside[i][0]`, then the next) that hold
   * all of shape i centred on (0, 0) — where shape i is never worth more than that larger one would be.
   */
  readonly inside: readonly (readonly [number, Int16Array])[][];
}

const prepared = new WeakMap<object, PreparedShapes>();

/**
 * Shapes as rows of text: `#` (or `@`) a tile of the shape, `@` its centre, anything else not. A row of a shape must
 * be one run of tiles — the game's sight ranges are — which is what makes the test of a fit a row at a time.
 */
export function prepareShapes(shapes: readonly (readonly string[])[]): PreparedShapes {
  const hit = prepared.get(shapes);
  if (hit) return hit;
  const cells: Int16Array[] = [], runs: Int16Array[] = [];
  shapes.forEach((rows, i) => {
    const cy = rows.findIndex((r) => r.includes("@"));
    if (cy < 0) throw new Error(`Shape ${i + 1} has no centre: mark it with @.`);
    const cx = rows[cy].indexOf("@");
    const c: number[] = [], r: number[] = [];
    rows.forEach((row, y) => {
      let from = -1, to = -1;
      for (let x = 0; x < row.length; x++) {
        if (row[x] !== "#" && row[x] !== "@") continue;
        if (from >= 0 && to !== x - 1) throw new Error(`Shape ${i + 1}, row ${y + 1}: a row of a shape is one run of tiles.`);
        if (from < 0) from = x;
        to = x;
        c.push(x - cx, y - cy);
      }
      if (from >= 0) r.push(y - cy, from - cx, to - cx);
    });
    cells.push(Int16Array.from(c));
    runs.push(Int16Array.from(r));
  });
  const has = (i: number, dx: number, dy: number) => { const c = cells[i]; for (let k = 0; k < c.length; k += 2) if (c[k] === dx && c[k + 1] === dy) return true; return false; };
  let nested = true;
  for (let i = 0; i + 1 < cells.length && nested; i++) for (let k = 0; k < cells[i].length; k += 2) if (!has(i + 1, cells[i][k], cells[i][k + 1])) { nested = false; break; }
  // Shape i inside shape j (one or two sizes up) moved by (dx, dy): what lets a candidate a larger one holds be left out.
  const inside: [number, Int16Array][][] = cells.map(() => []);
  if (nested) {
    for (let i = 0; i < cells.length; i++) for (let j = i + 1; j <= i + 2 && j < cells.length; j++) {
      const places: number[] = [];
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        if (dx === 0 && dy === 0) continue;
        let all = true;
        for (let k = 0; k < cells[i].length && all; k += 2) all = has(j, cells[i][k] - dx, cells[i][k + 1] - dy);
        if (all) places.push(dx, dy);
      }
      if (places.length) inside[i].push([j, Int16Array.from(places)]);
    }
  }
  const out: PreparedShapes = Object.freeze({ count: shapes.length, cells, runs, nested, inside });
  prepared.set(shapes, out);
  return out;
}

/**
 * The brushes that cover a picture's ink: `ink` is width × height, row by row, 1 for ink. Every brush lies on ink
 * inside the picture, except those of the last pass, on ink too thin for any shape (which stay inside it where the
 * picture is three tiles across and four down). In order of shape, the first first.
 */
export function cover(ink: Uint8Array, width: number, height: number, shapes: PreparedShapes): CoverBrush[] {
  const n = width * height;
  // Dark tiles before each place in its row: a run is all ink when the count does not change across it.
  const dark = new Int32Array(n + height);
  for (let y = 0; y < height; y++) {
    const at = y * (width + 1);
    for (let x = 0; x < width; x++) dark[at + x + 1] = dark[at + x] + (ink[y * width + x] ? 0 : 1);
  }
  const fits = (s: number, cx: number, cy: number): boolean => {
    const r = shapes.runs[s];
    for (let k = 0; k < r.length; k += 3) {
      const y = cy + r[k], x0 = cx + r[k + 1], x1 = cx + r[k + 2];
      if (y < 0 || y >= height || x0 < 0 || x1 >= width) return false;
      const at = y * (width + 1);
      if (dark[at + x1 + 1] !== dark[at + x0]) return false;
    }
    return true;
  };
  const covered = new Uint8Array(n);
  // Covered tiles before each place in its row, the same way, brought up to date a row at a time as brushes are chosen.
  const done = new Int32Array(n + height);
  const recount = (y: number) => {
    const at = y * (width + 1);
    for (let x = 0; x < width; x++) done[at + x + 1] = done[at + x] + covered[y * width + x];
  };
  const gain = (s: number, cx: number, cy: number): number => {
    const r = shapes.runs[s];
    let g = 0;
    for (let k = 0; k < r.length; k += 3) {
      const at = (cy + r[k]) * (width + 1), x0 = cx + r[k + 1], x1 = cx + r[k + 2];
      g += x1 - x0 + 1 - (done[at + x1 + 1] - done[at + x0]);
    }
    return g;
  };
  let left = 0;
  for (let i = 0; i < n; i++) left += ink[i] ? 1 : 0;
  const chosen: CoverBrush[] = [];
  if (left) {
    // A binary max-heap of (gain, candidate); a candidate is (shape * height + y) * width + x.
    const room = shapes.nested ? n : n * shapes.count;
    const gains = new Int32Array(room), keys = new Int32Array(room);
    let size = 0;
    const swap = (a: number, b: number) => { const g = gains[a], k = keys[a]; gains[a] = gains[b]; keys[a] = keys[b]; gains[b] = g; keys[b] = k; };
    const up = (i: number) => { while (i > 0) { const p = (i - 1) >> 1; if (gains[p] >= gains[i]) break; swap(p, i); i = p; } };
    const down = (i: number) => { for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < size && gains[l] > gains[m]) m = l; if (r < size && gains[r] > gains[m]) m = r; if (m === i) break; swap(m, i); i = m; } };
    const push = (g: number, key: number) => { gains[size] = g; keys[size] = key; up(size++); };
    if (shapes.nested) {
      // The largest that fits on each tile (a shape fits only where the one inside it does), -1 for none …
      const largest = new Int8Array(n).fill(-1);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (!ink[y * width + x]) continue;
        // (Searched by halves: if a shape fits, every one inside it does.)
        let lo = -1, hi = shapes.count - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fits(mid, x, y)) lo = mid; else hi = mid - 1; }
        largest[y * width + x] = lo;
      }
      // … each a candidate unless a larger shape that fits beside it holds it all: then it never gains more than that one.
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const s = largest[y * width + x];
        if (s < 0) continue;
        let held = false;
        for (const [j, places] of shapes.inside[s]) {
          for (let k = 0; k < places.length && !held; k += 2) {
            const X = x + places[k], Y = y + places[k + 1];
            held = X >= 0 && X < width && Y >= 0 && Y < height && largest[Y * width + X] >= j;
          }
          if (held) break;
        }
        if (!held) push(shapes.cells[s].length >> 1, (s * height + y) * width + x);
      }
    } else {
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (!ink[y * width + x]) continue;
        for (let s = 0; s < shapes.count; s++) if (fits(s, x, y)) push(shapes.cells[s].length >> 1, (s * height + y) * width + x);
      }
    }
    while (size && left) {
      const key = keys[0], x = key % width, y = Math.floor(key / width) % height, s = Math.floor(key / (width * height));
      const g = gain(s, x, y);
      size--; swap(0, size); down(0);
      if (g === 0) continue;
      if (size && g < gains[0]) { push(g, key); continue; }
      chosen.push({ x, y, shape: s });
      const c = shapes.cells[s];
      for (let k = 0; k < c.length; k += 2) { const i = (y + c[k + 1]) * width + x + c[k]; if (!covered[i]) { covered[i] = 1; left--; } }
      const r = shapes.runs[s];
      for (let k = 0; k < r.length; k += 3) recount(y + r[k]);
    }
  }
  // Ink thinner than any shape: the smallest over each tile still uncovered, lighting a tile or two beside it — placed,
  // of every place it covers that tile from, inside the picture where it can be and on the fewest tiles not ink.
  if (left) {
    const c = shapes.cells[0];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (!ink[y * width + x] || covered[y * width + x]) continue;
      let best = -1, bx = x, by = y;
      for (let k = 0; k < c.length; k += 2) {
        const cx = x - c[k], cy = y - c[k + 1];
        let cost = 0;
        for (let j = 0; j < c.length; j += 2) {
          const X = cx + c[j], Y = cy + c[j + 1];
          cost += X < 0 || X >= width || Y < 0 || Y >= height ? 1000 : ink[Y * width + X] ? 0 : 1;
        }
        if (best < 0 || cost < best) { best = cost; bx = cx; by = cy; }
      }
      chosen.push({ x: bx, y: by, shape: 0 });
      for (let k = 0; k < c.length; k += 2) {
        const X = bx + c[k], Y = by + c[k + 1];
        if (X >= 0 && X < width && Y >= 0 && Y < height) covered[Y * width + X] = 1;
      }
    }
  }
  return chosen.sort((a, b) => a.shape - b.shape);
}

/** What brushes cover inside a width × height picture: 1 a tile covered. For checks. */
export function covers(brushes: readonly CoverBrush[], width: number, height: number, shapes: PreparedShapes): Uint8Array {
  const out = new Uint8Array(width * height);
  for (const b of brushes) {
    const c = shapes.cells[b.shape];
    for (let k = 0; k < c.length; k += 2) {
      const X = b.x + c[k], Y = b.y + c[k + 1];
      if (X >= 0 && X < width && Y >= 0 && Y < height) out[Y * width + X] = 1;
    }
  }
  return out;
}

/** What `cover()` gives a script: a brush as the shape's place in the list given and the tile it is centred on. */
export interface ScriptBrush { readonly x: number; readonly y: number; readonly shape: number }

const byKey = new Map<string, PreparedShapes>();
const ofVideos = new WeakMap<object, Map<string, readonly (readonly ScriptBrush[])[]>>();

/** Rows of text (`#` ink) as width × height bytes, the rows' width the longest. */
export function inkOf(rows: readonly string[]): { ink: Uint8Array; width: number; height: number } {
  const height = rows.length, width = Math.max(0, ...rows.map((r) => r.length));
  const ink = new Uint8Array(width * height);
  rows.forEach((r, y) => { for (let x = 0; x < r.length; x++) if (r[x] === "#") ink[y * width + x] = 1; });
  return { ink, width, height };
}

/**
 * `cover(picture, shapes)` of the language: a picture's brushes, or a video's frame by frame. A video's are worked
 * out once for as long as the script keeps the same file and shapes (a build reads them again on every compile); for
 * Bad Apple that is fourteen seconds the first time.
 */
export function coverValue(picture: unknown, shapesArg: unknown, video: { isVideo(v: unknown): v is { length: number; width: number; height: number; tiles(i: number): Uint8Array } }): readonly ScriptBrush[] | readonly (readonly ScriptBrush[])[] {
  if (!Array.isArray(shapesArg) || shapesArg.length === 0 || !shapesArg.every((s) => Array.isArray(s) && s.every((r) => typeof r === "string"))) {
    throw new Error("cover(picture, shapes): the shapes are a list of shapes, each rows of text with # for its tiles and @ for its centre.");
  }
  const shapes = shapesArg as readonly (readonly string[])[];
  // Keyed by the text of the shapes: a library is run again on every compile, so its list is a new one each time.
  const key = shapes.map((s) => s.join("\n")).join("\n\n");
  let ready = byKey.get(key);
  if (!ready) { ready = prepareShapes(shapes.map((s) => [...s])); byKey.set(key, ready); }
  const brushes = (bs: CoverBrush[]): readonly ScriptBrush[] => Object.freeze(bs.map((b) => ({ x: b.x, y: b.y, shape: b.shape })));
  if (video.isVideo(picture)) {
    let byShapes = ofVideos.get(picture);
    if (!byShapes) { byShapes = new Map(); ofVideos.set(picture, byShapes); }
    const hit = byShapes.get(key);
    if (hit) return hit;
    const frames: (readonly ScriptBrush[])[] = [];
    for (let i = 0; i < picture.length; i++) frames.push(brushes(cover(picture.tiles(i), picture.width, picture.height, ready)));
    const out = Object.freeze(frames);
    byShapes.set(key, out);
    return out;
  }
  if (!Array.isArray(picture) || !picture.every((r) => typeof r === "string")) throw new Error("cover(picture, shapes): the picture is rows of text (# its ink), or a video a script imported.");
  const { ink, width, height } = inkOf(picture as string[]);
  return brushes(cover(ink, width, height, ready));
}
