/**
 * Videos a script imports (TrigScript 4, B8): `import badApple from "./bad-apple.video"`. A `.video` file is one of the
 * script's files, kept in the map with the others: the frames of a video as the editor decoded them when it was
 * imported — so many tiles wide and high, a frame for every frame of the game, each tile ink or not. The source video
 * is not kept; what is kept is what the build reads, and it reads the same on every computer, whichever browser or
 * codec decoded the original.
 *
 * The file is text, one line of JSON: the sizes, and the frames in base64, compressed the way JBIG compresses a fax:
 * each tile, row by row, is coded with a binary arithmetic coder (LZMA's range coder) whose odds come from the tiles
 * around it already coded — four above and two to the left in this frame, five around it in the frame before — so a
 * tile is cheap wherever it is what its neighbours and the last frame say it will be: most of every tile of a video.
 * The odds adapt as the coder goes, the same way when the file is read. Bad Apple — 5,216 frames of 128 × 96 — is
 * a few hundred kilobytes so, where a byte a tile would be 64 MB and runs of tiles 1.6 MB.
 *
 * What a script gets is a `Video` (below): its sizes, its length and each frame as rows of text, `#` ink — what
 * `fog.picture` takes. `fog.light(player, x, y, video, frame)` draws one while the game runs.
 */

/** The extension of a video among a script's files. */
export const VIDEO_EXTENSION = ".video";
export const isMediaFile = (path: string): boolean => path.toLowerCase().endsWith(VIDEO_EXTENSION);

/** A game frame on Fastest, in milliseconds: what a video imported "at the game's speed" has a frame for. */
export const FASTEST_FRAME_MS = 42;

/** The format's version, in the file. */
const VERSION = 1;

/** What the editor writes from a decoded video: each frame width × height bytes, row by row, non-zero for ink. */
export interface VideoFrames {
  width: number;
  height: number;
  /** How long a frame shows, in milliseconds: 42 is a frame of the game on Fastest. */
  frameMs: number;
  frames: readonly Uint8Array[];
  /** The file it was imported from, for the hover; a name, never a path. */
  source?: string;
}

interface VideoHeader { trigscript: "video"; version: number; width: number; height: number; frames: number; frameMs: number; source?: string; data: string }

/** The `.video` file's text for these frames. */
export function writeVideo(v: VideoFrames): string {
  const { width, height } = v;
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 256 && height <= 256)) throw new Error(`A video is 1 to 256 tiles each way, not ${width} × ${height}.`);
  const n = width * height;
  const coder = new RangeEncoder();
  const odds = new Uint16Array(1 << CONTEXT_BITS).fill(PROB_HALF);
  let previous = new Uint8Array(n), now = new Uint8Array(n);
  for (const frame of v.frames) {
    if (frame.length !== n) throw new Error(`A frame of a ${width} × ${height} video has ${n} tiles, not ${frame.length}.`);
    for (let i = 0; i < n; i++) now[i] = frame[i] ? 1 : 0;
    for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i++) coder.bit(odds, context(now, previous, width, height, x, y), now[i]);
    [previous, now] = [now, previous];
  }
  const header: VideoHeader = { trigscript: "video", version: VERSION, width, height, frames: v.frames.length, frameMs: v.frameMs, ...(v.source ? { source: v.source } : {}), data: toBase64(coder.finish()) };
  return JSON.stringify(header);
}

/** A video as the build reads it: every frame unpacked to a bit a tile, a frame's bytes made when asked for. */
export interface VideoData {
  readonly width: number;
  readonly height: number;
  readonly length: number;
  readonly frameMs: number;
  readonly source?: string;
  /** Frame i, width × height bytes, 1 for ink. A new array each time. */
  tiles(i: number): Uint8Array;
}

/** Read a `.video` file's text. Throws, in words for the person, when it is not one. */
export function readVideo(text: string): VideoData {
  let h: Partial<VideoHeader>;
  try { h = JSON.parse(text) as Partial<VideoHeader>; } catch { throw new Error("This is not a video TrigScript imported: a .video file is one line of JSON."); }
  if (h?.trigscript !== "video" || typeof h.data !== "string") throw new Error("This is not a video TrigScript imported.");
  if (h.version !== VERSION) throw new Error(`This video was written by a newer TrigScript (format ${h.version}); update the plugin to read it.`);
  const width = Number(h.width), height = Number(h.height), length = Number(h.frames), frameMs = Number(h.frameMs);
  if (![width, height, length].every((k) => Number.isInteger(k) && k >= 0) || !(frameMs > 0)) throw new Error("The video's sizes are not whole numbers.");
  const n = width * height, stride = (n + 7) >> 3;
  const coder = new RangeDecoder(fromBase64(h.data));
  const odds = new Uint16Array(1 << CONTEXT_BITS).fill(PROB_HALF);
  const bits = new Uint8Array(stride * length);
  let previous = new Uint8Array(n), now = new Uint8Array(n);
  for (let f = 0; f < length; f++) {
    const base = f * stride;
    for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i++) {
      const b = coder.bit(odds, context(now, previous, width, height, x, y));
      now[i] = b;
      if (b) bits[base + (i >> 3)] |= 1 << (i & 7);
    }
    if (coder.overrun) throw new Error("The video's frames end too soon: the file is cut short.");
    [previous, now] = [now, previous];
  }
  return Object.freeze({
    width, height, length, frameMs, ...(typeof h.source === "string" ? { source: h.source } : {}),
    tiles(i: number): Uint8Array {
      if (!(Number.isInteger(i) && i >= 0 && i < length)) throw new RangeError(`The video has frames 0 … ${length - 1}; there is no frame ${i}.`);
      const out = new Uint8Array(n), base = i * stride;
      for (let k = 0; k < n; k++) out[k] = (bits[base + (k >> 3)] >> (k & 7)) & 1;
      return out;
    },
  });
}

/** What a script imports: `import badApple from "./bad-apple.video"`. */
export interface Video {
  readonly __trigscript: "video";
  readonly width: number;
  readonly height: number;
  /** How many frames. */
  readonly length: number;
  /** How long a frame shows, in milliseconds (42: a game frame on Fastest). */
  readonly frameMs: number;
  /** How long the whole video plays, in seconds. */
  readonly seconds: number;
  /** Frame i as rows of text, `#` ink and `.` not: what `fog.picture` takes. */
  frame(i: number): readonly string[];
  /** Frame i as bytes, 1 for ink; for the compiler's own work (`cover()`), not in the declarations. */
  tiles(i: number): Uint8Array;
}

export const isVideo = (v: unknown): v is Video => typeof v === "object" && v !== null && (v as Video).__trigscript === "video";

/**
 * The value an import of a `.video` file gives, kept while the text is the same: a build reads the file again each
 * time the script is compiled, and what is worked out from a video (`cover()` of its frames) is kept with it.
 */
const values = new Map<string, Video>();

export function videoValue(text: string): Video {
  const hit = values.get(text);
  if (hit) return hit;
  const data = readVideo(text);
  const video: Video = Object.freeze({
    __trigscript: "video" as const,
    width: data.width, height: data.height, length: data.length, frameMs: data.frameMs,
    seconds: (data.length * data.frameMs) / 1000,
    frame(i: number): readonly string[] {
      const t = data.tiles(i), rows: string[] = [];
      for (let y = 0; y < data.height; y++) {
        let row = "";
        for (let x = 0; x < data.width; x++) row += t[y * data.width + x] ? "#" : ".";
        rows.push(row);
      }
      return Object.freeze(rows);
    },
    tiles: (i: number) => data.tiles(i),
  });
  // A few videos at most are imported at a time; the oldest goes when a sixth arrives (an edit of the file is a new text).
  if (values.size >= 5) values.delete(values.keys().next().value!);
  values.set(text, video);
  return video;
}

/** What the hover on an import says: "a video, 128 × 96 tiles, 5,216 frames at the game's speed (3:39), from bad-apple.mkv". */
export function describeVideo(text: string): string {
  try {
    const v = readVideo(text);
    const seconds = Math.round((v.length * v.frameMs) / 1000);
    const speed = v.frameMs === FASTEST_FRAME_MS ? "at the game's speed on Fastest" : `${(1000 / v.frameMs).toFixed(1)} a second`;
    return `A video, ${v.width} × ${v.height} tiles, ${v.length.toLocaleString("en-US")} frame${v.length === 1 ? "" : "s"} ${speed} (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")})${v.source ? `, from ${v.source}` : ""}.`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/* ── The coding: a tile's odds by the tiles around it, and LZMA's binary range coder ── */

const CONTEXT_BITS = 11;
const PROB_BITS = 11, PROB_HALF = 1 << (PROB_BITS - 1), MOVE_BITS = 5, TOP = 1 << 24;

/**
 * Which odds tile (x, y) is coded with: in this frame the two to its left and the four above (NW N NE, and N of N);
 * in the frame before, itself and the four beside it. Off the picture a tile is 0. Only tiles already coded are used,
 * so reading the file can work out the same.
 */
function context(now: Uint8Array, previous: Uint8Array, width: number, height: number, x: number, y: number): number {
  const i = y * width + x;
  const left = x > 0, right = x + 1 < width, up = y > 0;
  return (left ? now[i - 1] : 0)
    | (x > 1 ? now[i - 2] : 0) << 1
    | (up && left ? now[i - width - 1] : 0) << 2
    | (up ? now[i - width] : 0) << 3
    | (up && right ? now[i - width + 1] : 0) << 4
    | (y > 1 ? now[i - 2 * width] : 0) << 5
    | previous[i] << 6
    | (left ? previous[i - 1] : 0) << 7
    | (right ? previous[i + 1] : 0) << 8
    | (up ? previous[i - width] : 0) << 9
    | (y + 1 < height ? previous[i + width] : 0) << 10;
}

/** LZMA's range encoder, a bit at a time with adaptive odds (`odds[k]`: the chance of a 0, out of 2048). */
class RangeEncoder {
  private low = 0;
  private range = 0xffffffff;
  private cache = 0;
  private cacheSize = 1;
  private out: number[] = [];

  bit(odds: Uint16Array, k: number, bit: number): void {
    const p = odds[k], bound = (this.range >>> PROB_BITS) * p;
    if (bit) { this.low += bound; this.range -= bound; odds[k] = p - (p >> MOVE_BITS); }
    else { this.range = bound; odds[k] = p + (((1 << PROB_BITS) - p) >> MOVE_BITS); }
    while (this.range < TOP) { this.range = (this.range * 256) >>> 0; this.shiftLow(); }
  }

  private shiftLow(): void {
    if (this.low < 0xff000000 || this.low >= 0x100000000) {
      const carry = this.low >= 0x100000000 ? 1 : 0;
      let byte = this.cache;
      do { this.out.push((byte + carry) & 0xff); byte = 0xff; } while (--this.cacheSize !== 0);
      this.cache = Math.floor(this.low / 0x1000000) & 0xff;
    }
    this.cacheSize++;
    this.low = (this.low % 0x1000000) * 256;
  }

  finish(): Uint8Array {
    for (let i = 0; i < 5; i++) this.shiftLow();
    return Uint8Array.from(this.out);
  }
}

class RangeDecoder {
  private range = 0xffffffff;
  private code = 0;
  private at = 0;
  /** Read past the end: the file was cut short. */
  overrun = false;

  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    for (let i = 0; i < 5; i++) this.code = ((this.code * 256) + this.next()) % 0x100000000;
  }

  private next(): number {
    if (this.at < this.bytes.length) return this.bytes[this.at++];
    this.overrun = this.at++ > this.bytes.length + 4;
    return 0;
  }

  bit(odds: Uint16Array, k: number): number {
    const p = odds[k], bound = (this.range >>> PROB_BITS) * p;
    let bit: number;
    if (this.code < bound) { this.range = bound; odds[k] = p + (((1 << PROB_BITS) - p) >> MOVE_BITS); bit = 0; }
    else { this.code -= bound; this.range -= bound; odds[k] = p - (p >> MOVE_BITS); bit = 1; }
    while (this.range < TOP) { this.range = (this.range * 256) >>> 0; this.code = ((this.code * 256) + this.next()) % 0x100000000; }
    return bit;
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
