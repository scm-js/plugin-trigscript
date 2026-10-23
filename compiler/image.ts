/**
 * Images a script imports: `import logo from "./logo.image"`. An `.image` file is one of the script's files, kept in
 * the map with the others: the pixels of a picture as the editor decoded them when it was imported — at the size the
 * person chose, in grey or in colour, with its transparency. The source file is not kept, for the reason a video's is
 * not (`media.ts`): a browser decodes a PNG or a JPEG through its own colour management, and what the build reads has
 * to be the same on every computer.
 *
 * What a script gets is an `Image` (below), worked on when the script is built: its pixels read one by one, and new
 * images made from it — cropped, scaled, flipped, turned, inverted — and, at the end, rows of text for `fog.picture`
 * (`threshold`, or `halftone` for greys the fog can show) or rows of tones a library draws its own way (`tones`). None of it reaches the game but what
 * the script makes of it.
 *
 * The file is text, one line of JSON: the sizes, which planes it has, and the planes in base64. Each plane is coded the
 * way lossless JPEG codes one: each pixel predicted from the three before it (left, above, above left — the median
 * edge detector of JPEG-LS), and what the prediction missed by coded with LZMA's range coder, its odds chosen by how
 * busy the neighbourhood is. Colour is coded as green, and red and blue as their differences from green, which are
 * small wherever a picture is near grey.
 */
import { FOG_SHAPES } from "./fogShapes";
import { fromBase64, PROB_HALF, RangeDecoder, RangeEncoder, toBase64 } from "./rangeCoder";

/** The extension of an image among a script's files. */
export const IMAGE_EXTENSION = ".image";
/** The most pixels an image is each way. */
export const MAX_IMAGE_SIDE = 1024;

/** The format's version, in the file. */
const VERSION = 1;

/** What the editor writes from a decoded picture: width × height pixels, four bytes each — red, green, blue, alpha. */
export interface ImagePixels {
  width: number;
  height: number;
  rgba: Uint8Array;
  /** Keep grey levels only, whatever colour the picture has. */
  grey?: boolean;
  /** The file it was imported from, for the hover; a name, never a path. */
  source?: string;
}

interface ImageHeader { trigscript: "image"; version: number; width: number; height: number; color: boolean; alpha: boolean; source?: string; data: string }

/** An image as the build reads it. */
export interface ImageData {
  readonly width: number;
  readonly height: number;
  /** Whether red, green and blue differ anywhere; when not, a pixel's grey is its red. */
  readonly color: boolean;
  /** Whether any pixel is less than opaque. */
  readonly alpha: boolean;
  readonly source?: string;
  /** Four bytes a pixel, row by row: red, green, blue, alpha. */
  readonly rgba: Uint8Array;
}

/** A pixel's grey, 0 black to 255 white: what Import Video… takes a picture's tiles by. */
const luma = (r: number, g: number, b: number): number => Math.round(0.299 * r + 0.587 * g + 0.114 * b);

/** The `.image` file's text for these pixels. */
export function writeImage(p: ImagePixels): string {
  const { width, height } = p;
  checkSize(width, height);
  const n = width * height;
  if (p.rgba.length !== n * 4) throw new Error(`A ${width} × ${height} image has ${n * 4} bytes of red, green, blue and alpha, not ${p.rgba.length}.`);
  const rgba = Uint8Array.from(p.rgba);
  if (p.grey) for (let i = 0; i < n * 4; i += 4) rgba[i] = rgba[i + 1] = rgba[i + 2] = luma(rgba[i], rgba[i + 1], rgba[i + 2]);
  let color = false, alpha = false;
  for (let i = 0; i < n * 4; i += 4) {
    if (rgba[i] !== rgba[i + 1] || rgba[i + 1] !== rgba[i + 2]) color = true;
    if (rgba[i + 3] !== 255) alpha = true;
  }
  const coder = new RangeEncoder();
  const odds = newOdds();
  planes(rgba, n, color, alpha).forEach((plane, k) => codePlane(plane, width, height, (ctx, value) => {
    // The value as eight bits, highest first, each with the odds of the bits above it.
    for (let bit = 7, node = 1; bit >= 0; bit--) {
      const b = (value >> bit) & 1;
      coder.bit(odds, oddsAt(k, ctx, node), b);
      node = node * 2 + b;
    }
    return value;
  }));
  const header: ImageHeader = { trigscript: "image", version: VERSION, width, height, color, alpha, ...(p.source ? { source: p.source } : {}), data: toBase64(coder.finish()) };
  return JSON.stringify(header);
}

/** Read an `.image` file's text. Throws, in words for the person, when it is not one. */
export function readImage(text: string): ImageData {
  let h: Partial<ImageHeader>;
  try { h = JSON.parse(text) as Partial<ImageHeader>; } catch { throw new Error("This is not an image TrigScript imported: an .image file is one line of JSON."); }
  if (h?.trigscript !== "image" || typeof h.data !== "string") throw new Error("This is not an image TrigScript imported.");
  if (h.version !== VERSION) throw new Error(`This image was written by a newer TrigScript (format ${h.version}); update the plugin to read it.`);
  const width = Number(h.width), height = Number(h.height), color = h.color === true, alpha = h.alpha === true;
  checkSize(width, height);
  const n = width * height;
  const coder = new RangeDecoder(fromBase64(h.data));
  const odds = newOdds();
  const got = planes(new Uint8Array(n * 4), n, color, alpha).map((plane, k) => {
    codePlane(plane, width, height, (ctx) => {
      let node = 1;
      for (let bit = 0; bit < 8; bit++) node = node * 2 + coder.bit(odds, oddsAt(k, ctx, node));
      return node - 256;
    });
    if (coder.overrun) throw new Error("The image's pixels end too soon: the file is cut short.");
    return plane;
  });
  const rgba = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    if (color) {
      const g = got[0][i];
      rgba[i * 4] = (got[1][i] + g - 128) & 255;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = (got[2][i] + g - 128) & 255;
    } else rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = got[0][i];
    rgba[i * 4 + 3] = alpha ? got[color ? 3 : 1][i] : 255;
  }
  return Object.freeze({ width, height, color, alpha, ...(typeof h.source === "string" ? { source: h.source } : {}), rgba });
}

/** What the hover on an import says: "An image, 64 × 48 pixels, in colour, with transparency, from logo.png." */
export function describeImage(text: string): string {
  try {
    // The header alone: the pixels are not decoded for this.
    const h = JSON.parse(text) as Partial<ImageHeader>;
    if (h?.trigscript !== "image") return "This is not an image TrigScript imported.";
    return `An image, ${Number(h.width)} × ${Number(h.height)} pixels, ${h.color ? "in colour" : "in grey"}${h.alpha ? ", with transparency" : ""}${typeof h.source === "string" ? `, from ${h.source}` : ""}.`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function checkSize(width: number, height: number): void {
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= MAX_IMAGE_SIDE && height <= MAX_IMAGE_SIDE)) {
    throw new Error(`An image is 1 to ${MAX_IMAGE_SIDE} pixels each way, not ${width} × ${height}.`);
  }
}

/* ── The coding ── */

/** How many kinds of neighbourhood a pixel's odds are chosen by: flat, then busier by powers of two. */
const BUSY = 8;

const newOdds = () => new Uint16Array(4 * BUSY * 256).fill(PROB_HALF);
const oddsAt = (plane: number, busy: number, node: number) => (plane * BUSY + busy) * 256 + node;

/**
 * The planes a file holds, as arrays `codePlane` fills or reads: grey (or green, red − green + 128, blue − green +
 * 128), then alpha when there is any. Writing, they are made from `rgba`; reading, they start empty.
 */
function planes(rgba: Uint8Array, n: number, color: boolean, alpha: boolean): Uint8Array[] {
  const plane = (f: (i: number) => number) => Uint8Array.from({ length: n }, (_, i) => f(i * 4));
  const out = color
    ? [plane((i) => rgba[i + 1]), plane((i) => (rgba[i] - rgba[i + 1] + 128) & 255), plane((i) => (rgba[i + 2] - rgba[i + 1] + 128) & 255)]
    : [plane((i) => rgba[i])];
  if (alpha) out.push(plane((i) => rgba[i + 3]));
  return out;
}

/**
 * Each pixel of a plane in turn, row by row: `code` is given how busy the neighbourhood is and what the prediction
 * missed by (folded to 0 … 255: 0, −1, 1, −2, …) — the value to write, or, reading, a value it ignores — and gives
 * back the miss, which puts the pixel in the plane.
 */
function codePlane(plane: Uint8Array, width: number, height: number, code: (busy: number, miss: number) => number): void {
  for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i++) {
    // Off the picture: the first row has only its left, the first column only what is above.
    const a = x > 0 ? plane[i - 1] : y > 0 ? plane[i - width] : 0;
    const b = y > 0 ? plane[i - width] : a;
    const c = x > 0 && y > 0 ? plane[i - width - 1] : b;
    const guess = c >= Math.max(a, b) ? Math.min(a, b) : c <= Math.min(a, b) ? Math.max(a, b) : a + b - c;
    const d = Math.abs(a - c) + Math.abs(b - c);
    const busy = d === 0 ? 0 : Math.min(BUSY - 1, 1 + Math.floor(Math.log2(d)));
    const e = (plane[i] - guess) & 255, s = e < 128 ? e : e - 256;
    const got = code(busy, s >= 0 ? 2 * s : -2 * s - 1);
    plane[i] = (guess + (got & 1 ? -(got + 1) / 2 : got / 2)) & 255;
  }
}

/* ── What a script gets ── */

/** Rows of text, as `fog.picture` takes them. */
type Rows = readonly string[];

/** A brush of a halftone: which of the fog's shapes (0 the first), centred on tile (x, y) of the picture. */
export interface HalftoneBrush { readonly x: number; readonly y: number; readonly shape: number }

/** What a script imports: `import logo from "./logo.image"`. Every method is worked out when the script is built. */
export interface Image {
  readonly __trigscript: "image";
  readonly width: number;
  readonly height: number;
  /** Whether it has colour; when not, its red, green and blue are its grey. */
  readonly color: boolean;
  /** Whether any pixel is less than opaque. */
  readonly transparent: boolean;
  grey(x: number, y: number): number;
  rgb(x: number, y: number): { readonly r: number; readonly g: number; readonly b: number };
  alpha(x: number, y: number): number;
  crop(x: number, y: number, width: number, height: number): Image;
  scale(width: number, height?: number): Image;
  flip(axis: "horizontal" | "vertical"): Image;
  rotate(turn: 90 | 180 | 270): Image;
  invert(): Image;
  threshold(level?: number, options?: { readonly ink?: "light" | "dark" }): Rows;
  tones(count: number): Rows;
  halftone(cellWidth: number, cellHeight?: number, options?: { readonly diffuse?: boolean }): Rows;
}

export const isImage = (v: unknown): v is Image => typeof v === "object" && v !== null && (v as Image).__trigscript === "image";

/** A pixel at least this opaque is part of the picture: anything less is never ink. */
const OPAQUE = 128;

const whole = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`${what} is a whole number, not ${String(v)}.`);
  return v;
};

const inkOf = (options: { readonly ink?: unknown } | undefined): boolean => {
  const ink = options?.ink ?? "light";
  if (ink !== "light" && ink !== "dark") throw new Error(`ink is "light" or "dark", not ${JSON.stringify(ink)}.`);
  return ink === "dark";
};

/** The value of the image these pixels are. */
export function makeImage(d: ImageData): Image {
  const { width: w, height: h, rgba } = d;
  const n = w * h;
  const at = (x: unknown, y: unknown): number => {
    whole(x, "x");
    whole(y, "y");
    if ((x as number) < 0 || (y as number) < 0 || (x as number) >= w || (y as number) >= h) throw new RangeError(`The image is ${w} × ${h}; there is no pixel (${String(x)}, ${String(y)}).`);
    return ((y as number) * w + (x as number)) * 4;
  };
  const greyAt = (i: number) => (d.color ? luma(rgba[i], rgba[i + 1], rgba[i + 2]) : rgba[i]);
  // An image of another size, each pixel taken from this one's pixel at `from(x, y)`.
  const remap = (nw: number, nh: number, from: (x: number, y: number) => number): Image => {
    const out = new Uint8Array(nw * nh * 4);
    for (let y = 0, o = 0; y < nh; y++) for (let x = 0; x < nw; x++, o += 4) out.set(rgba.subarray(from(x, y), from(x, y) + 4), o);
    return makeImage({ ...d, width: nw, height: nh, rgba: out });
  };
  // Rows of text, a character a pixel; a pixel that is not opaque enough is ".".
  const rows = (char: (grey: number, i: number) => string): Rows => {
    const out: string[] = [];
    for (let y = 0; y < h; y++) {
      let row = "";
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        row += rgba[i + 3] < OPAQUE ? "." : char(greyAt(i), y * w + x);
      }
      out.push(row);
    }
    return Object.freeze(out);
  };
  const image: Image = {
    __trigscript: "image",
    width: w,
    height: h,
    color: d.color,
    transparent: d.alpha,
    grey: (x, y) => greyAt(at(x, y)),
    rgb: (x, y) => { const i = at(x, y); return Object.freeze({ r: rgba[i], g: rgba[i + 1], b: rgba[i + 2] }); },
    alpha: (x, y) => rgba[at(x, y) + 3],
    crop(x, y, cw, ch) {
      for (const [v, what] of [[x, "x"], [y, "y"], [cw, "width"], [ch, "height"]] as const) whole(v, what);
      if (x < 0 || y < 0 || cw < 1 || ch < 1 || x + cw > w || y + ch > h) throw new RangeError(`crop(${x}, ${y}, ${cw}, ${ch}) is not inside the image, which is ${w} × ${h}.`);
      return remap(cw, ch, (px, py) => ((y + py) * w + x + px) * 4);
    },
    scale(sw, sh) {
      whole(sw, "width");
      const th = sh === undefined ? Math.max(1, Math.round((sw * h) / w)) : whole(sh, "height");
      checkSize(sw, th);
      return makeImage({ ...d, width: sw, height: th, rgba: resample(rgba, w, h, sw, th) });
    },
    flip(axis) {
      if (axis === "horizontal") return remap(w, h, (x, y) => (y * w + (w - 1 - x)) * 4);
      if (axis === "vertical") return remap(w, h, (x, y) => ((h - 1 - y) * w + x) * 4);
      throw new Error(`flip() takes "horizontal" or "vertical", not ${JSON.stringify(axis)}.`);
    },
    rotate(turn) {
      // Clockwise: the new image's top row is the old one's left column, read from the bottom up.
      if (turn === 90) return remap(h, w, (x, y) => ((h - 1 - x) * w + y) * 4);
      if (turn === 180) return remap(w, h, (x, y) => ((h - 1 - y) * w + (w - 1 - x)) * 4);
      if (turn === 270) return remap(h, w, (x, y) => (x * w + (w - 1 - y)) * 4);
      throw new Error(`rotate() turns by 90, 180 or 270 degrees clockwise, not ${String(turn)}.`);
    },
    invert() {
      const out = Uint8Array.from(rgba);
      for (let i = 0; i < n * 4; i += 4) { out[i] = 255 - out[i]; out[i + 1] = 255 - out[i + 1]; out[i + 2] = 255 - out[i + 2]; }
      return makeImage({ ...d, rgba: out });
    },
    threshold(level = 128, options) {
      if (typeof level !== "number" || !(level >= 0 && level <= 256)) throw new RangeError(`threshold() takes a grey from 0 to 256, not ${String(level)}.`);
      const dark = inkOf(options);
      return rows((g) => ((g >= level) !== dark ? "#" : "."));
    },
    tones(count) {
      whole(count, "tones()' count");
      if (count < 2 || count > 10) throw new RangeError(`tones() makes 2 to 10 tones, a digit each, not ${count}.`);
      return rows((g) => String(Math.min(count - 1, Math.floor((g * count) / 256))));
    },
    halftone(cw, ch, options) {
      whole(cw, "halftone()'s cell width");
      const cellH = ch === undefined ? cw + 1 : whole(ch, "halftone()'s cell height");
      if (cw < 3 || cellH < 4 || cw > 32 || cellH > 32) throw new RangeError(`halftone() takes cells 3 to 32 tiles across and 4 to 32 down (the smallest brush is 3 × 4), not ${cw} × ${cellH}.`);
      return halftone(w, h, (i) => (rgba[i * 4 + 3] < OPAQUE ? -1 : greyAt(i * 4)), cw, cellH, options?.diffuse !== false);
    },
  };
  return Object.freeze(image);
}

/**
 * Grey in the fog: the picture cut into cells, each lit by one of the fog's own brushes or none — a larger one for a
 * lighter cell, the largest a tile past the cell on each side so that neighbours run together into white. Cells are
 * taken row by row: each chooses, of none and each brush centred on it, the one whose new light — the tiles it lights
 * that nothing lit before, wherever they are — is nearest the cell's grey times its size; what that missed by is
 * handed on to the cells after it (Floyd–Steinberg, a cell a step), so an area's share of light is its grey. Without
 * `diffuse`, each cell's brush is the nearest to its own grey alone: an even grid of dots, the greys in steps. One brush a cell at
 * most, each drawn exactly as the game lights it and inside the picture; the rows carry them as `brushes`. `grey(i)` is pixel i's grey, or −1 where it is not opaque enough;
 * a cell mostly of those is left dark.
 */
function halftone(w: number, h: number, grey: (i: number) => number, cw: number, ch: number, diffuse: boolean): Rows {
  const lit = new Uint8Array(w * h), brushes: HalftoneBrush[] = [];
  // Where the cells start, each way; what is left over at the end, too thin for a brush, goes to the cell before it.
  const starts = (size: number, cell: number, least: number) => {
    const at: number[] = [];
    for (let p = 0; p < size; p += cell) at.push(p);
    if (at.length > 1 && size - at[at.length - 1] < least) at.pop();
    return [...at, size];
  };
  const xs = starts(w, cw, 3), ys = starts(h, ch, 4);
  const cols = xs.length - 1, rowsOfCells = ys.length - 1;
  const err = new Float32Array(cols * rowsOfCells);
  for (let cy = 0; cy < rowsOfCells; cy++) for (let cx = 0; cx < cols; cx++) {
    const x0 = xs[cx], y0 = ys[cy], x1 = xs[cx + 1], y1 = ys[cy + 1];
    const area = (x1 - x0) * (y1 - y0);
    let sum = 0, seen = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const g = grey(y * w + x); if (g >= 0) { sum += g; seen++; } }
    if (seen * 2 < area) continue;
    // A brush centred on the cell — moved in from an edge of the picture, which it never lights past — the tiles it
    // lights and the tile it is centred on; null for one larger than the picture.
    const place = (shape: readonly string[]) => {
      const fit = (at: number, size: number, room: number) => Math.max(0, Math.min(room - size, at));
      const sx = fit(x0 + ((x1 - x0 - shape[0].length) >> 1), shape[0].length, w), sy = fit(y0 + ((y1 - y0 - shape.length) >> 1), shape.length, h), tiles: number[] = [];
      let centre = { x: 0, y: 0 }, inside = true;
      shape.forEach((row, dy) => {
        for (let dx = 0; dx < row.length; dx++) {
          const x = sx + dx, y = sy + dy;
          if (row[dx] === "@") centre = { x, y };
          if (row[dx] === ".") continue;
          if (x < 0 || y < 0 || x >= w || y >= h) inside = false;
          else tiles.push(y * w + x);
        }
      });
      return inside ? { tiles, centre } : null;
    };
    // What a brush gives, as a share of the cell: every tile it lights that nothing lit before, in this cell or past
    // it — what spills into a neighbour is light this cell put there, and the neighbour counts only its own.
    const share = (tiles: readonly number[]) => tiles.reduce((n, i) => n + (lit[i] ? 0 : 1), 0) / area;
    const want = sum / seen / 255 + err[cy * cols + cx];
    let best: { tiles: number[]; centre: { x: number; y: number }; shape: number } | null = null, bestShare = 0;
    for (const [k, shape] of FOG_SHAPES.entries()) {
      if (shape[0].length > x1 - x0 + 2 || shape.length > y1 - y0 + 2) break;
      const at = place(shape);
      if (!at) continue;
      const s = share(at.tiles);
      if (Math.abs(s - want) < Math.abs(bestShare - want)) { best = { ...at, shape: k }; bestShare = s; }
    }
    if (best) {
      for (const i of best.tiles) lit[i] = 1;
      brushes.push(Object.freeze({ ...best.centre, shape: best.shape }));
    }
    const miss = diffuse ? want - bestShare : 0;
    const give = (dx: number, dy: number, part: number) => {
      const nx = cx + dx, ny = cy + dy;
      if (nx >= 0 && nx < cols && ny < rowsOfCells) err[ny * cols + nx] += (miss * part) / 16;
    };
    give(1, 0, 7); give(-1, 1, 3); give(0, 1, 5); give(1, 1, 1);
  }
  const out: string[] = [];
  for (let y = 0; y < h; y++) { let row = ""; for (let x = 0; x < w; x++) row += lit[y * w + x] ? "#" : "."; out.push(row); }
  // The rows carry the brushes that drew them, which fog.picture takes as they are: covering their union again could
  // take more, where discs run together.
  return Object.freeze(Object.assign(out, { brushes: Object.freeze(brushes) }));
}

/**
 * Pixels at another size, each the average of the part of the picture under it — the parts of pixels it covers
 * counting for as much as they cover. Shrinking, that is an area's average; growing by a whole number, each pixel
 * becomes a block of itself. Colour is averaged by how opaque it is, so transparent pixels darken no edge.
 */
function resample(rgba: Uint8Array, w: number, h: number, tw: number, th: number): Uint8Array {
  // For each new column (row), the old columns (rows) under it and how much of each.
  const spans = (from: number, to: number) => Array.from({ length: to }, (_, t) => {
    const lo = (t * from) / to, hi = ((t + 1) * from) / to, parts: [number, number][] = [];
    for (let s = Math.floor(lo); s < Math.min(from, Math.ceil(hi)); s++) parts.push([s, Math.min(hi, s + 1) - Math.max(lo, s)]);
    return parts;
  });
  const xs = spans(w, tw), ys = spans(h, th);
  const out = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    let r = 0, g = 0, b = 0, a = 0, area = 0;
    for (const [sy, wy] of ys[y]) for (const [sx, wx] of xs[x]) {
      const i = (sy * w + sx) * 4, part = wx * wy, opaque = (rgba[i + 3] / 255) * part;
      r += rgba[i] * opaque; g += rgba[i + 1] * opaque; b += rgba[i + 2] * opaque;
      a += rgba[i + 3] * part;
      area += part;
    }
    const o = (y * tw + x) * 4, weight = (a / 255) || 1;
    out[o] = Math.round(r / weight); out[o + 1] = Math.round(g / weight); out[o + 2] = Math.round(b / weight);
    out[o + 3] = Math.round(a / area);
  }
  return out;
}

/** The value an import of an `.image` file gives, kept while the text is the same (a build reads the files each time). */
const values = new Map<string, Image>();

export function imageValue(text: string): Image {
  const hit = values.get(text);
  if (hit) return hit;
  const image = makeImage(readImage(text));
  if (values.size >= 8) values.delete(values.keys().next().value!);
  values.set(text, image);
  return image;
}
