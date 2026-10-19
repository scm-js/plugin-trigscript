/**
 * Sounds a script imports or makes: `import boom from "./boom.sound"`, `tone("A4", 0.3)`. A `.sound` file is one of
 * the script's files, kept in the map with the others: the samples the editor decoded when it was imported, mono, at
 * the rate chosen, as IMA ADPCM — four bits a sample, the coding the game's own sounds use and the one the map gets.
 * The source file is not kept, as a video's and an image's are not: what the build reads is the same everywhere.
 *
 * What a script gets is a `Clip` (below), one channel or two, worked on when the script is built — trimmed, made
 * louder or quieter, faded, reversed, pitched, joined, mixed, repeated, panned, limited — or made from nothing by
 * `tone`, `noise` and `silence`. A clip a program plays (`playWav(boom)`) is written into the map's archive when the
 * script is built, named by what it holds (`staredit\wav\trigscript-<hash>.wav` or `.ogg`), once however often it is
 * played; nothing else of it reaches the game. Two seconds or more is Ogg Vorbis (`clipFile`, `vorbis.ts`); shorter is
 * a WAV of IMA ADPCM, a quarter of 16-bit, but for a tone the coding would make harsh, which goes in as 16-bit PCM:
 * ADPCM codes each sample as a step from the last, and the jumps of a square or a saw wave come back ringing — 8 dB,
 * heard as a harsh end to every note of the first sound demo (2026-10-19). See `adpcmWillDo`.
 *
 * What StarCraft: Remastered does with them (the sound probe, 2026-10-19): a sound starts on its mixer's 21.3 ms grid,
 * up to one buffer after its frame; playing one again starts a second copy beside the first, and nothing stops one,
 * so a note's length and loudness are its file's; 32 play at once; copies add, with no limiter; loudness is kept as
 * written. IMA ADPCM, PCM and Ogg Vorbis play; Ogg Opus does not.
 */
import { fromBase64, toBase64 } from "./rangeCoder";
import { chorus, compressor, curve, echo, echoTail, eq, fmVoice, plate, plateTail, pluckVoice, saturate, seeded, svf, type FilterType, type Points } from "./dsp";

/** The extension of a sound among a script's files. */
export const SOUND_EXTENSION = ".sound";
/** The longest a clip may be, in seconds. */
export const MAX_SECONDS = 600;
/** The rate a clip is made at when nothing says otherwise. */
export const DEFAULT_RATE = 22050;

/** The format's version, in the file. */
const VERSION = 1;

interface SoundHeader { trigscript: "sound"; version: number; rate: number; frames: number; source?: string; data: string }

/* ── IMA ADPCM, as a WAV holds it: mono blocks, each a sample and a step index, then two samples a byte ── */

const INDEX_STEP = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060,
  1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484,
  7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

/** A block's size in bytes for a rate, as the usual tools choose it: 256 at 11 kHz, 512 at 22, 1024 at 44. */
const blockAlign = (rate: number) => 256 * Math.max(1, Math.round(rate / 11025));
const samplesPerBlock = (align: number) => (align - 4) * 2 + 1;

/** Samples (−1 … 1) as IMA ADPCM blocks; the last block filled out with silence. */
export function encodeAdpcm(samples: Float32Array, rate: number): Uint8Array {
  const align = blockAlign(rate), per = samplesPerBlock(align);
  const blocks = Math.max(1, Math.ceil(samples.length / per));
  const out = new Uint8Array(blocks * align);
  const at = (i: number) => (i < samples.length ? Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))) : 0);
  let index = 0;
  for (let b = 0; b < blocks; b++) {
    const base = b * align, first = b * per;
    let predicted = at(first);
    out[base] = predicted & 255; out[base + 1] = (predicted >> 8) & 255; out[base + 2] = index; out[base + 3] = 0;
    for (let k = 1; k < per; k++) {
      const step = STEPS[index];
      let diff = at(first + k) - predicted, code = 0;
      if (diff < 0) { code = 8; diff = -diff; }
      let delta = step >> 3;
      if (diff >= step) { code |= 4; diff -= step; delta += step; }
      if (diff >= step >> 1) { code |= 2; diff -= step >> 1; delta += step >> 1; }
      if (diff >= step >> 2) { code |= 1; delta += step >> 2; }
      predicted = Math.max(-32768, Math.min(32767, predicted + (code & 8 ? -delta : delta)));
      index = Math.max(0, Math.min(88, index + INDEX_STEP[code]));
      const byte = base + 4 + ((k - 1) >> 1);
      out[byte] |= (k - 1) & 1 ? code << 4 : code;
    }
  }
  return out;
}

/** IMA ADPCM blocks back to `frames` samples (−1 … 1). */
export function decodeAdpcm(data: Uint8Array, rate: number, frames: number): Float32Array {
  const align = blockAlign(rate), per = samplesPerBlock(align), out = new Float32Array(frames);
  for (let b = 0, n = 0; b * align < data.length && n < frames; b++) {
    const base = b * align;
    let predicted = (data[base] | (data[base + 1] << 8)) << 16 >> 16, index = Math.min(88, data[base + 2]);
    out[n++] = predicted / 32767;
    for (let k = 1; k < per && n < frames; k++) {
      const byte = data[base + 4 + ((k - 1) >> 1)], code = (k - 1) & 1 ? byte >> 4 : byte & 15, step = STEPS[index];
      let delta = step >> 3;
      if (code & 4) delta += step;
      if (code & 2) delta += step >> 1;
      if (code & 1) delta += step >> 2;
      predicted = Math.max(-32768, Math.min(32767, predicted + (code & 8 ? -delta : delta)));
      index = Math.max(0, Math.min(88, index + INDEX_STEP[code]));
      out[n++] = predicted / 32767;
    }
  }
  return out;
}

/** A WAV of IMA ADPCM blocks: what the map's archive gets for a clip. */
export function adpcmWav(data: Uint8Array, rate: number, frames: number): Uint8Array {
  const align = blockAlign(rate), per = samplesPerBlock(align);
  const out = new Uint8Array(60 + data.length), v = new DataView(out.buffer);
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  text(0, "RIFF"); v.setUint32(4, 52 + data.length, true); text(8, "WAVE");
  text(12, "fmt "); v.setUint32(16, 20, true);
  v.setUint16(20, 0x11, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, Math.round((rate * align) / per), true); v.setUint16(32, align, true); v.setUint16(34, 4, true);
  v.setUint16(36, 2, true); v.setUint16(38, per, true);
  text(40, "fact"); v.setUint32(44, 4, true); v.setUint32(48, frames, true);
  text(52, "data"); v.setUint32(56, data.length, true);
  out.set(data, 60);
  return out;
}

/** A WAV of 16-bit PCM, one channel or two: what the map gets for a clip ADPCM would distort, or a short one with two sides. */
export function pcmWav(samples: Float32Array | readonly Float32Array[], rate: number): Uint8Array {
  const chans = samples instanceof Float32Array ? [samples] : samples, n = chans.length, frames = chans[0].length, size = frames * n * 2;
  const out = new Uint8Array(44 + size), v = new DataView(out.buffer);
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  text(0, "RIFF"); v.setUint32(4, 36 + size, true); text(8, "WAVE");
  text(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, n, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2 * n, true); v.setUint16(32, 2 * n, true); v.setUint16(34, 16, true);
  text(36, "data"); v.setUint32(40, size, true);
  for (let i = 0; i < frames; i++) for (let c = 0; c < n; c++) v.setInt16(44 + (i * n + c) * 2, Math.round(Math.max(-1, Math.min(1, chans[c][i])) * 32767), true);
  return out;
}

/** How close ADPCM keeps samples to themselves, in dB: the samples' power over the error's. */
export function adpcmFidelity(samples: Float32Array, rate: number, adpcm = encodeAdpcm(samples, rate)): number {
  const back = decodeAdpcm(adpcm, rate, samples.length);
  let signal = 0, error = 0;
  for (let i = 0; i < samples.length; i++) { const c = Math.max(-1, Math.min(1, samples[i])); signal += c * c; error += (back[i] - c) ** 2; }
  return error === 0 ? Infinity : signal === 0 ? -Infinity : 10 * Math.log10(signal / error);
}

/**
 * How much a clip repeats itself, 0 … 1: the best match of its middle with itself a period later, for periods from
 * 4 samples to a 40 Hz note's. A tone is near 1; noise near 0.
 */
export function periodicity(samples: Float32Array, rate: number): number {
  const n = Math.min(4096, samples.length), from = Math.max(0, (samples.length - n) >> 1), most = Math.min(Math.floor(rate / 40), n >> 1);
  let best = 0;
  for (let lag = 4; lag <= most; lag++) {
    let xy = 0, xx = 0, yy = 0;
    for (let i = from; i < from + n - lag; i++) { const a = samples[i], b = samples[i + lag]; xy += a * b; xx += a * a; yy += b * b; }
    if (xx > 0 && yy > 0) best = Math.max(best, xy / Math.sqrt(xx * yy));
  }
  return best;
}

/**
 * Below this, a tonal clip goes in the map as 16-bit. Played 2026-10-19: square-wave notes at 11.8–16.6 dB were heard
 * as harsh, a plucked string's notes at 18.2–23.6 dB as clean; over noise the error is lost in the noise (a snare at
 * 14.7 dB and a hat at 11.2 dB sounded fine), so noise keeps ADPCM whatever its figure.
 */
export const ADPCM_FIDELITY = 18;
/** A clip that repeats itself this much is a tone for ADPCM_FIDELITY. */
export const TONAL = 0.5;

/** Whether a clip goes in the map as ADPCM: unless it is a tone the coding would make harsh. */
export const adpcmWillDo = (samples: Float32Array, rate: number, adpcm?: Uint8Array): boolean =>
  adpcmFidelity(samples, rate, adpcm) >= ADPCM_FIDELITY || periodicity(samples, rate) < TONAL;

/* ── The .sound file ── */

/** What the editor writes from a decoded sound: mono samples (−1 … 1) at `rate`. */
export interface SoundSamples { rate: number; samples: Float32Array; source?: string }

/** The `.sound` file's text for these samples. */
export function writeSound(s: SoundSamples): string {
  checkRate(s.rate);
  if (s.samples.length / s.rate > MAX_SECONDS) throw new Error(`A sound is at most ${MAX_SECONDS / 60} minutes long, not ${(s.samples.length / s.rate / 60).toFixed(1)}.`);
  const header: SoundHeader = { trigscript: "sound", version: VERSION, rate: s.rate, frames: s.samples.length, ...(s.source ? { source: s.source } : {}), data: toBase64(encodeAdpcm(s.samples, s.rate)) };
  return JSON.stringify(header);
}

/** A `.sound` file as the build reads it. */
export interface SoundData { readonly rate: number; readonly frames: number; readonly source?: string; readonly adpcm: Uint8Array; readonly samples: Float32Array }

/** Read a `.sound` file's text. Throws, in words for the person, when it is not one. */
export function readSound(text: string): SoundData {
  let h: Partial<SoundHeader>;
  try { h = JSON.parse(text) as Partial<SoundHeader>; } catch { throw new Error("This is not a sound TrigScript imported: a .sound file is one line of JSON."); }
  if (h?.trigscript !== "sound" || typeof h.data !== "string") throw new Error("This is not a sound TrigScript imported.");
  if (h.version !== VERSION) throw new Error(`This sound was written by a newer TrigScript (format ${h.version}); update the plugin to read it.`);
  const rate = Number(h.rate), frames = Number(h.frames);
  checkRate(rate);
  if (!(Number.isInteger(frames) && frames >= 0 && frames <= MAX_SECONDS * rate)) throw new Error("The sound's length is not a whole number of samples.");
  const adpcm = fromBase64(h.data), align = blockAlign(rate);
  if (adpcm.length < Math.ceil(frames / samplesPerBlock(align)) * align) throw new Error("The sound's samples end too soon: the file is cut short.");
  return Object.freeze({ rate, frames, ...(typeof h.source === "string" ? { source: h.source } : {}), adpcm, samples: decodeAdpcm(adpcm, rate, frames) });
}

/** What the hover on an import says: "A sound, 2.4 seconds at 22 050 Hz, from boom.mp3." */
export function describeSound(text: string): string {
  try {
    const h = JSON.parse(text) as Partial<SoundHeader>;
    if (h?.trigscript !== "sound") return "This is not a sound TrigScript imported.";
    const rate = Number(h.rate), seconds = Number(h.frames) / rate;
    return `A sound, ${seconds.toFixed(seconds < 10 ? 2 : 1)} seconds at ${rate.toLocaleString("en-US")} Hz${typeof h.source === "string" ? `, from ${h.source}` : ""}.`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function checkRate(rate: number): void {
  if (!(Number.isInteger(rate) && rate >= 8000 && rate <= 48000)) throw new Error(`A sound's rate is 8 000 to 48 000 samples a second, not ${rate}.`);
}

/* ── What a script gets ── */

/**
 * A sound when the script is built. Its length, rate and channels are known at once; its samples are worked out only
 * when something needs them — the map's file, at a build, or `peak` — so a check as the user types, which needs neither,
 * runs a song's whole mix without making a sample of it.
 */
export interface Clip {
  readonly __trigscript: "clip";
  readonly seconds: number;
  readonly rate: number;
  /** 1, or 2 for a clip with a left and a right. */
  readonly channels: 1 | 2;
  /** The loudest sample, 0 … 1 (more than 1 clips when the map's file is written). Reading it works the samples out. */
  readonly peak: number;
  trim(from: number, to?: number): Clip;
  gain(factor: number): Clip;
  fade(inSeconds: number, outSeconds?: number): Clip;
  reverse(): Clip;
  pitch(semitones: number): Clip;
  then(...clips: Clip[]): Clip;
  mix(other: Clip, at?: number): Clip;
  repeat(times: number): Clip;
  envelope(...points: readonly (readonly [number, number])[]): Clip;
  pan(position: number): Clip;
  mono(): Clip;
  limit(options?: { readonly ceiling?: number; readonly release?: number }): Clip;
  normalize(peak?: number): Clip;
  wav(): Clip;
  filter(type: FilterType, cutoff: number | Points, options?: { readonly resonance?: number; readonly gain?: number; readonly q?: number }): Clip;
  drive(dB: number): Clip;
  delay(seconds: number, options?: { readonly feedback?: number; readonly mix?: number; readonly tone?: number; readonly pingPong?: boolean }): Clip;
  reverb(options?: { readonly decay?: number; readonly damping?: number; readonly predelay?: number; readonly mix?: number; readonly dry?: number; readonly width?: number }): Clip;
  chorus(options?: { readonly speed?: number; readonly depth?: number; readonly mix?: number }): Clip;
  compress(options?: { readonly threshold?: number; readonly ratio?: number; readonly attack?: number; readonly release?: number; readonly knee?: number; readonly makeup?: number }): Clip;
}

interface ClipInside {
  readonly frames: number;
  /** The samples, once worked out; until then, what works them out. */
  channels?: readonly Float32Array[];
  compute?: () => readonly Float32Array[];
  peak?: number;
  adpcm?: Uint8Array;
  wav?: boolean;
  /** What the clip is (`keyOf`). */
  key?: string;
}
const inside = new WeakMap<Clip, ClipInside>();

export const isClip = (v: unknown): v is Clip => typeof v === "object" && v !== null && (v as Clip).__trigscript === "clip";

const num = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what} is a number, not ${String(v)}.`);
  return v;
};

/** A clip's samples, worked out the first time they are asked for. */
function samplesOf(c: Clip): readonly Float32Array[] {
  const own = inside.get(c)!;
  if (!own.channels) {
    const made = own.compute!();
    if (made.length !== c.channels || made.some((s) => s.length !== own.frames)) throw new Error(`Internal: a clip's samples came out ${made.map((s) => s.length).join("+")} long, not ${c.channels} × ${own.frames}.`);
    own.channels = made;
    // What worked them out is let go, and with it the clips they came from.
    own.compute = undefined;
  }
  return own.channels;
}

/*
 * What a clip is, as a key: worked out from how it was made — the clip it came from, the method and its arguments — or,
 * for samples from elsewhere, from the samples. Two clips made the same way have the same key: the map's file is named
 * by it (so a check knows the name without the samples), and a clip made the same way twice in one build is the same
 * clip, its samples worked out once (kept by a weak reference: a clip nothing holds any more is let go).
 */
const cache = new Map<string, WeakRef<Clip>>();

/** Two 32-bit hashes of a text, as 16 hex digits. */
function hashText(text: string): string {
  let a = 0x811c9dc5, b = 0x9747b28c;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0; b = (b ^ (b >>> 15)) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** A clip's key: how it was made, or its samples. */
export function keyOf(c: Clip): string {
  const own = inside.get(c)!;
  if (own.key) return own.key;
  let a = 0x811c9dc5, b = 0x9747b28c;
  for (const s of samplesOf(c)) {
    const words = new Uint32Array(s.buffer, s.byteOffset, s.length);
    for (let i = 0; i < words.length; i++) { a = Math.imul(a ^ words[i], 0x01000193) >>> 0; b = Math.imul(b ^ words[i], 0x5bd1e995) >>> 0; b = (b ^ (b >>> 15)) >>> 0; }
  }
  own.key = `s${c.rate}:${c.channels}:${a.toString(16)}${b.toString(16)}`;
  return own.key;
}

/** The key of a clip made by `op` from these arguments (clips among them by their keys). */
const recipe = (op: string, args: unknown): string => hashText(`${op}|${JSON.stringify(args, (_, v) => (isClip(v) ? `clip:${keyOf(v)}` : v))}`);

/** The clip `key` names, if one is still held; else `make`'s, kept under it. */
function made(key: string, make: () => Clip): Clip {
  const hit = cache.get(key)?.deref();
  if (hit) return hit;
  const c = make(), own = inside.get(c)!;
  if (own.key) return c;
  own.key = key;
  cache.set(key, new WeakRef(c));
  if (cache.size > 8192) for (const [k, r] of cache) if (!r.deref()) cache.delete(k);
  return c;
}

/*
 * Resampling by a windowed sinc: each new sample the old ones weighed by sin(πx)/(πx) under a Blackman window 16 samples
 * each side, its cutoff lowered to the new rate's half when that is the lower, so a note pitched up does not fold its
 * top back down as other pitches. (Straight lines between samples did both: dulled the top and folded it.)
 */
const HALF = 16, RES = 512;
const KERNEL = (() => {
  const t = new Float32Array(HALF * RES + 2);
  for (let i = 0; i < t.length; i++) {
    const u = i / RES;
    const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
    t[i] = u >= HALF ? 0 : sinc * (0.42 + 0.5 * Math.cos((Math.PI * u) / HALF) + 0.08 * Math.cos((2 * Math.PI * u) / HALF));
  }
  return t;
})();

/** The length `n` samples at `from` come to at `to`. */
const resampled = (n: number, from: number, to: number) => (from === to ? n : Math.max(1, Math.round((n * to) / from)));

/** `samples` at `rate`, as a rate of its own. */
function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const n = resampled(samples.length, from, to), out = new Float32Array(n), r = from / to;
  const c = Math.min(1, to / from), reach = HALF / c, last = samples.length - 1;
  for (let i = 0; i < n; i++) {
    const p = i * r, a = Math.max(0, Math.floor(p - reach) + 1), b = Math.min(last, Math.floor(p + reach));
    let sum = 0;
    for (let j = a; j <= b; j++) {
      const u = Math.abs(j - p) * c * RES, k = u | 0;
      sum += samples[j] * (KERNEL[k] + (KERNEL[k + 1] - KERNEL[k]) * (u - k));
    }
    out[i] = sum * c;
  }
  return out;
}

/** A clip's frames at `rate`. */
const framesAt = (c: Clip, rate: number) => resampled(inside.get(c)!.frames, c.rate, rate);

/** A clip's channels at `rate` and as many channels as `channels`: a mono one heard the same from both sides. */
const channelsAt = (c: Clip, rate: number, channels: number): Float32Array[] => {
  const own = samplesOf(c).map((s) => resample(s, c.rate, rate));
  return channels === 2 && own.length === 1 ? [own[0], own[0]] : own;
};

/** A plain loop over a channel: a typed array's own map() calls back far more slowly, and a song's notes come by the hundred. */
const each = (s: Float32Array, f: (x: number, i: number) => number): Float32Array => {
  const out = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = f(s[i], i);
  return out;
};
const scale = (s: Float32Array, g: Float32Array | number): Float32Array => {
  const out = new Float32Array(s.length);
  if (typeof g === "number") for (let i = 0; i < s.length; i++) out[i] = s[i] * g;
  else for (let i = 0; i < s.length; i++) out[i] = s[i] * g[i];
  return out;
};

/** The clip these channels are (one, or a left and a right of the same length). */
export function makeClip(samples: Float32Array | readonly Float32Array[], rate: number, adpcm?: Uint8Array, wav?: boolean): Clip {
  const chans: readonly Float32Array[] = samples instanceof Float32Array ? [samples] : samples;
  if (chans.length !== 1 && chans.length !== 2) throw new Error("A clip has one channel or two.");
  const frames = chans[0].length;
  if (chans.some((s) => s.length !== frames)) throw new Error("A clip's channels are the same length.");
  return lazyClip(rate, frames, chans.length as 1 | 2, () => chans, { channels: chans, ...(adpcm ? { adpcm } : {}), ...(wav ? { wav } : {}) });
}

/** A clip `frames` long whose samples `compute` works out when they are asked for. */
function lazyClip(rate: number, frames: number, channels: 1 | 2, compute: () => readonly Float32Array[], extra: Partial<ClipInside> = {}): Clip {
  if (frames / rate > MAX_SECONDS) throw new Error(`A clip is at most ${MAX_SECONDS / 60} minutes long, not ${(frames / rate / 60).toFixed(1)}.`);
  const seconds = frames / rate, wav = extra.wav === true;
  const at = (t: number) => Math.max(0, Math.min(frames, Math.round(t * rate)));
  /** A clip made from this one by `op`, `n` frames and `count` channels long, its samples from these. */
  const derive = (op: string, args: unknown, n: number, count: 1 | 2, from: (chans: readonly Float32Array[]) => readonly Float32Array[], also: Partial<ClipInside> = {}) =>
    made(recipe(`${keyOf(clip)}|${wav ? 1 : 0}|${op}`, args), () => lazyClip(rate, n, count, () => from(samplesOf(clip)), { ...(wav ? { wav } : {}), ...also }));
  const same = (op: string, args: unknown, from: (chans: readonly Float32Array[]) => readonly Float32Array[]) => derive(op, args, frames, channels, from);
  const clip: Clip = {
    __trigscript: "clip",
    seconds,
    rate,
    channels,
    get peak() {
      const own = inside.get(clip)!;
      if (own.peak === undefined) {
        let p = 0;
        for (const s of samplesOf(clip)) for (let i = 0; i < s.length; i++) { const x = s[i] < 0 ? -s[i] : s[i]; if (x > p) p = x; }
        own.peak = p;
      }
      return own.peak;
    },
    trim(from, to = seconds) {
      num(from, "trim()'s start"); num(to, "trim()'s end");
      if (from < 0 || to > seconds + 1e-9 || to <= from) throw new RangeError(`trim(${from}, ${to}) is not inside the clip, which is ${seconds.toFixed(3)} seconds.`);
      return derive("trim", [from, to], at(to) - at(from), channels, (cs) => cs.map((s) => s.slice(at(from), at(to))));
    },
    gain(factor) {
      if (num(factor, "gain()") < 0) throw new RangeError(`gain() is 0 or more (0.5 half as loud, 2 twice), not ${factor}.`);
      return same("gain", [factor], (cs) => cs.map((s) => scale(s, factor)));
    },
    fade(fadeIn, fadeOut = 0) {
      num(fadeIn, "fade()'s in"); num(fadeOut, "fade()'s out");
      if (fadeIn < 0 || fadeOut < 0) throw new RangeError("fade() takes seconds, 0 or more.");
      const a = fadeIn * rate, b = fadeOut * rate;
      return same("fade", [fadeIn, fadeOut], (cs) => cs.map((s) => each(s, (x, i) => x * Math.min(1, a ? i / a : 1, b ? (frames - 1 - i) / b : 1))));
    },
    reverse() { return same("reverse", [], (cs) => cs.map((s) => s.slice().reverse())); },
    pitch(semitones) {
      // Faster and higher, or slower and lower, as a sampler plays a note: the clip read at another speed.
      const ratio = 2 ** (num(semitones, "pitch()") / 12);
      return derive("pitch", [semitones], resampled(frames, rate * ratio, rate), channels, (cs) => cs.map((s) => resample(s, rate * ratio, rate)));
    },
    then(...clips) {
      for (const c of clips) if (!isClip(c)) throw new Error("then() joins clips.");
      const n = Math.max(channels, ...clips.map((c) => c.channels)) as 1 | 2;
      const total = frames + clips.reduce((s, c) => s + framesAt(c, rate), 0);
      return derive("then", [clips], total, n, () => {
        const parts = [clip, ...clips].map((c) => channelsAt(c, rate, n));
        return Array.from({ length: n }, (_, side) => {
          const out = new Float32Array(total);
          let o = 0;
          for (const p of parts) { out.set(p[side], o); o += p[side].length; }
          return out;
        });
      });
    },
    mix(other, start = 0) {
      if (!isClip(other)) throw new Error("mix() takes a clip.");
      if (num(start, "mix()'s start") < 0) throw new RangeError("mix()'s start is 0 seconds or more.");
      const n = Math.max(channels, other.channels) as 1 | 2, from = Math.round(start * rate), length = Math.max(frames, from + framesAt(other, rate));
      return derive("mix", [other, start], length, n, () => {
        const mine = channelsAt(clip, rate, n), theirs = channelsAt(other, rate, n);
        return mine.map((s, side) => {
          const o = theirs[side], out = new Float32Array(length);
          out.set(s);
          for (let i = 0; i < o.length; i++) out[from + i] += o[i];
          return out;
        });
      });
    },
    envelope(...points) {
      // Loudness through the clip, a straight line between [seconds, level] points: the first level before the first,
      // the last after the last.
      if (points.length === 0) throw new Error("envelope() takes [seconds, level] points: envelope([0, 0], [0.01, 1], [0.3, 0]).");
      const ps = points.map((p, k) => {
        if (!Array.isArray(p) || p.length !== 2) throw new Error(`envelope()'s point ${k + 1} is [seconds, level].`);
        return [num(p[0], "a point's seconds"), num(p[1], "a point's level")] as [number, number];
      });
      for (let k = 1; k < ps.length; k++) if (ps[k][0] < ps[k - 1][0]) throw new RangeError("envelope()'s points go forward in time.");
      return same("envelope", ps, (cs) => { const levels = curve(ps, rate, frames); return cs.map((s) => scale(s, levels)); });
    },
    repeat(times) {
      if (!Number.isInteger(num(times, "repeat()")) || times < 1) throw new RangeError(`repeat() takes a whole number of times, 1 or more, not ${times}.`);
      return derive("repeat", [times], frames * times, channels, (cs) => cs.map((s) => {
        const out = new Float32Array(s.length * times);
        for (let k = 0; k < times; k++) out.set(s, k * s.length);
        return out;
      }));
    },
    pan(position) {
      // A balance: the far side turned down, the near one kept, so the middle (0) is the clip as it was.
      if (!(num(position, "pan()") >= -1 && position <= 1)) throw new RangeError(`pan() is −1 (left) to 1 (right), 0 the middle, not ${position}.`);
      const l = Math.min(1, 1 - position), r = Math.min(1, 1 + position);
      return derive("pan", [position], frames, 2, (cs) => [scale(cs[0], l), scale(cs[cs.length - 1], r)]);
    },
    mono() {
      if (channels === 1) return clip;
      return derive("mono", [], frames, 1, (cs) => [each(cs[0], (x, i) => (x + cs[1][i]) / 2)]);
    },
    limit(options = {}) {
      const ceiling = options.ceiling ?? LIMIT_CEILING, release = options.release ?? 0.1;
      if (!(num(ceiling, "limit()'s ceiling") > 0 && ceiling <= 1)) throw new RangeError(`limit()'s ceiling is more than 0 and at most 1, not ${ceiling}.`);
      if (!(num(release, "limit()'s release") >= 0)) throw new RangeError("limit()'s release is seconds, 0 or more.");
      return same("limit", [ceiling, release], (cs) => { const g = limiterGain(cs, rate, ceiling, release); return cs.map((s) => scale(s, g)); });
    },
    normalize(to = LIMIT_CEILING) {
      if (!(num(to, "normalize()") > 0 && to <= 1)) throw new RangeError(`normalize() makes the loudest sample more than 0 and at most 1, not ${to}.`);
      return same("normalize", [to], (cs) => { const p = clip.peak; return p === 0 ? cs : cs.map((s) => scale(s, to / p)); });
    },
    wav() {
      if (wav) return clip;
      const own = inside.get(clip)!;
      return made(`${keyOf(clip)}|wav`, () => lazyClip(rate, frames, channels, () => samplesOf(clip), { wav: true, ...(own.adpcm ? { adpcm: own.adpcm } : {}) }));
    },
    filter(type, cutoff, options = {}) {
      const between = (v: number | undefined, d: number, lo: number, hi: number, what: string) => {
        const x = v ?? d;
        if (!(num(x, what) >= lo && x <= hi)) throw new RangeError(`${what} is ${lo} to ${hi}, not ${x}.`);
        return x;
      };
      const hzOk = (hz: unknown, what: string) => { if (!(num(hz, what) > 0)) throw new RangeError(`${what} is hertz, more than 0, not ${String(hz)}.`); };
      if (type === "lowshelf" || type === "highshelf" || type === "peak") {
        if (typeof cutoff !== "number") throw new Error(`filter("${type}") takes one frequency, not points.`);
        hzOk(cutoff, "filter()'s frequency");
        const gain = between(options.gain, 0, -48, 48, `filter("${type}")'s gain (dB)`), q = between(options.q, Math.SQRT1_2, 0.1, 30, "filter()'s q");
        return same("eq", [type, cutoff, gain, q], (cs) => eq(cs, rate, type, Math.min(cutoff, rate * 0.49), gain, q));
      }
      if (!["lowpass", "highpass", "bandpass", "notch"].includes(type)) throw new Error(`filter()'s type is "lowpass", "highpass", "bandpass", "notch", "lowshelf", "highshelf" or "peak", not ${JSON.stringify(type)}.`);
      if (typeof cutoff === "number") hzOk(cutoff, "filter()'s cutoff");
      else if (Array.isArray(cutoff) && cutoff.length > 0) cutoff.forEach((p, k) => {
        if (!Array.isArray(p) || p.length !== 2) throw new Error(`filter()'s cutoff point ${k + 1} is [seconds, hertz].`);
        num(p[0], "a cutoff point's seconds"); hzOk(p[1], "a cutoff point's hertz");
      });
      else throw new Error("filter()'s cutoff is hertz, or [seconds, hertz] points to sweep it.");
      const resonance = between(options.resonance, 0, 0, 1, "filter()'s resonance");
      return same("filter", [type, cutoff, resonance], (cs) => svf(cs, rate, type as "lowpass", cutoff, resonance));
    },
    drive(dB) {
      if (!(num(dB, "drive()") >= 0 && dB <= 48)) throw new RangeError(`drive() is 0 to 48 dB of push, not ${dB}.`);
      if (dB === 0) return clip;
      return same("drive", [dB], (cs) => saturate(cs, dB, (s) => resample(s, rate, rate * 2), (s) => resample(s, rate * 2, rate)));
    },
    delay(seconds, options = {}) {
      const feedback = options.feedback ?? 0.35, mix = options.mix ?? 0.35, toneHz = options.tone ?? 5000, pingPong = options.pingPong === true;
      if (!(num(seconds, "delay()'s time") > 0 && seconds <= 5)) throw new RangeError(`delay()'s time is more than 0, at most 5 seconds, not ${seconds}.`);
      if (!(num(feedback, "delay()'s feedback") >= 0 && feedback < 1)) throw new RangeError(`delay()'s feedback is 0 to less than 1, not ${feedback}.`);
      if (!(num(mix, "delay()'s mix") >= 0 && mix <= 1)) throw new RangeError(`delay()'s mix is 0 to 1, not ${mix}.`);
      if (!(num(toneHz, "delay()'s tone") > 0)) throw new RangeError(`delay()'s tone is hertz, more than 0, not ${toneHz}.`);
      return derive("delay", [seconds, feedback, mix, toneHz, pingPong], frames + echoTail(rate, seconds, feedback), pingPong ? 2 : channels, (cs) => echo(cs, rate, seconds, feedback, mix, Math.min(toneHz, rate * 0.45), pingPong));
    },
    reverb(options = {}) {
      const o = { decay: options.decay ?? 0.6, damping: options.damping ?? 0.4, predelay: options.predelay ?? 0.015, mix: options.mix ?? 0.3, dry: options.dry ?? 1, width: options.width ?? 1 };
      for (const [k, v, hi] of [["decay", o.decay, 1], ["damping", o.damping, 1], ["predelay", o.predelay, 0.5], ["mix", o.mix, 2], ["dry", o.dry, 2], ["width", o.width, 1]] as const) {
        if (!(num(v, `reverb()'s ${k}`) >= 0 && v <= hi)) throw new RangeError(`reverb()'s ${k} is 0 to ${hi}, not ${v}.`);
      }
      const tail = Math.round(plateTail(o.decay, o.predelay) * rate);
      return derive("reverb", o, frames + tail, 2, (cs) => plate(cs, rate, o, tail));
    },
    chorus(options = {}) {
      const speed = options.speed ?? 0.8, depth = options.depth ?? 0.003, mix = options.mix ?? 0.5;
      if (!(num(speed, "chorus()'s speed") > 0 && speed <= 20)) throw new RangeError(`chorus()'s speed is more than 0, at most 20 Hz, not ${speed}.`);
      if (!(num(depth, "chorus()'s depth") >= 0 && depth <= 0.01)) throw new RangeError(`chorus()'s depth is 0 to 0.01 seconds, not ${depth}.`);
      if (!(num(mix, "chorus()'s mix") >= 0 && mix <= 1)) throw new RangeError(`chorus()'s mix is 0 to 1, not ${mix}.`);
      return derive("chorus", [speed, depth, mix], frames, 2, (cs) => chorus(cs, rate, speed, depth, mix));
    },
    compress(options = {}) {
      const o = { threshold: options.threshold ?? -18, ratio: options.ratio ?? 4, attack: options.attack ?? 0.005, release: options.release ?? 0.12, knee: options.knee ?? 6, makeup: options.makeup ?? 0 };
      if (!(num(o.threshold, "compress()'s threshold") <= 0 && o.threshold >= -60)) throw new RangeError(`compress()'s threshold is −60 to 0 dB, not ${o.threshold}.`);
      if (!(num(o.ratio, "compress()'s ratio") >= 1 && o.ratio <= 100)) throw new RangeError(`compress()'s ratio is 1 to 100, not ${o.ratio}.`);
      for (const [k, v] of [["attack", o.attack], ["release", o.release], ["knee", o.knee]] as const) if (!(num(v, `compress()'s ${k}`) >= 0)) throw new RangeError(`compress()'s ${k} is 0 or more, not ${v}.`);
      if (!(num(o.makeup, "compress()'s makeup") >= -24 && o.makeup <= 24)) throw new RangeError(`compress()'s makeup is −24 to 24 dB, not ${o.makeup}.`);
      return same("compress", o, (cs) => compressor(cs, rate, o));
    },
  };
  inside.set(clip, { frames, compute, ...extra });
  return Object.freeze(clip);
}

/** The level `limit` keeps a clip under unless told otherwise, and `normalize` brings it to: −1.5 dB. Ogg Vorbis comes
 * back up to a dB louder at its peaks than what went in (a song limited to −1 dB peaked at −0.16 dB, decoded), so the
 * margin keeps a limited song from clipping in the game. */
export const LIMIT_CEILING = 0.84;
/** How far ahead the limiter looks, in seconds: it turns down this long before a peak, so the peak is never over. */
const LOOKAHEAD = 0.005;

/**
 * The limiter's gain each sample, the same for both sides: under the ceiling everywhere. What each sample needs (the
 * ceiling over its loudest side, 1 at most) is taken at its lowest over the next 5 ms, then averaged over 5 ms — each
 * average covers the window of every sample before the peak, so it is no higher than the peak needs, and the gain
 * goes down smoothly over the 5 ms before it — and it comes back up over `release` seconds.
 */
function limiterGain(chans: readonly Float32Array[], rate: number, ceiling: number, release: number): Float32Array {
  const n = chans[0].length, L = Math.max(1, Math.round(LOOKAHEAD * rate));
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const s of chans) m = Math.max(m, Math.abs(s[i]));
    need[i] = m > ceiling ? ceiling / m : 1;
  }
  // The lowest over [i, i + L): a queue of indices whose needs rise, the front the lowest.
  const low = new Float32Array(n), queue = new Int32Array(n + L);
  let head = 0, tail = 0;
  for (let j = 0; j < n + L - 1; j++) {
    if (j < n) {
      while (tail > head && need[queue[tail - 1]] >= need[j]) tail--;
      queue[tail++] = j;
    }
    const i = j - L + 1;
    if (i < 0) continue;
    while (queue[head] < i) head++;
    low[i] = need[queue[head]];
  }
  // Averaged over (i − L, i], then released. (Before the first sample the need is 1: the sum starts at L ones.)
  const gain = new Float32Array(n), back = release > 0 ? 1 - Math.exp(-1 / (release * rate)) : 1;
  let sum = L, g = 1;
  for (let i = 0; i < n; i++) {
    sum += low[i] - (i >= L ? low[i - L] : 1);
    const target = Math.min(1, sum / L);
    g = target < g ? target : g + (target - g) * back;
    gain[i] = g;
  }
  return gain;
}

/**
 * Many clips laid over one another, each from its own time (seconds), as one clip at the first's rate (or `rate`):
 * what a song sounds like when it is mixed when the script is built. Two channels when any part has two. `seconds`
 * makes it that long at least.
 */
export function mixdown(parts: unknown, seconds?: unknown, rate?: number): Clip {
  if (!Array.isArray(parts) || parts.length === 0) throw new Error("mixdown() takes { clip, at } parts, one at least.");
  const list = parts.map((p, k) => {
    const c = (p as { clip?: unknown })?.clip, at = (p as { at?: unknown })?.at ?? 0;
    if (!isClip(c)) throw new Error(`mixdown()'s part ${k + 1} has no clip.`);
    if (num(at, "a part's time") < 0) throw new RangeError("A part's time is 0 seconds or more.");
    return { c, at: at as number };
  });
  if (rate !== undefined) checkRate(rate);
  const to = rate ?? list[0].c.rate;
  const n = Math.max(...list.map((p) => p.c.channels)) as 1 | 2;
  const length = Math.max(seconds === undefined ? 0 : Math.round(num(seconds, "mixdown()'s length") * to), ...list.map((p) => Math.round(p.at * to) + framesAt(p.c, to)));
  if (length / to > MAX_SECONDS) throw new RangeError(`A clip is at most ${MAX_SECONDS / 60} minutes long.`);
  return made(recipe("mixdown", [list.map((p) => [p.c, p.at]), length, to]), () => lazyClip(to, length, n, () => {
    const out = Array.from({ length: n }, () => new Float32Array(length));
    // A clip played many times is resampled once.
    const at = new Map<Clip, Float32Array[]>();
    for (const p of list) {
      let s = at.get(p.c);
      if (!s) { s = channelsAt(p.c, to, n); at.set(p.c, s); }
      const from = Math.round(p.at * to);
      for (let side = 0; side < n; side++) {
        const src = s[side], dst = out[side];
        for (let i = 0; i < src.length && from + i < length; i++) dst[from + i] += src[i];
      }
    }
    return out;
  }));
}

/** A clip's samples, mono (for the compiler's own work and the editor's player, not in the declarations). */
export const clipSamples = (c: Clip): Float32Array => {
  const ch = samplesOf(c);
  return ch.length === 1 ? ch[0] : each(ch[0], (x, i) => (x + ch[1][i]) / 2);
};
/** A clip's channels as they are. */
export const clipChannels = (c: Clip): readonly Float32Array[] => samplesOf(c);

/**
 * At this length or more a clip a program plays goes in the map as Ogg Vorbis (Remastered plays it; 1.16.1 plays only
 * WAVs): a song, mixed, is a tenth the size and keeps its top and its two sides. Shorter ones stay WAVs, which start on
 * their frame (the sound probe), as do an import as it was (its own ADPCM), a clip a trigger plays (`runtime.ts`), and
 * one made `wav()`.
 */
export const VORBIS_SECONDS = 2;
/** libvorbis's quality, −1 … 10: 5 is about 160 kbit/s for two channels at 44.1 kHz. */
export const VORBIS_QUALITY = 5;
/**
 * Goes into every file's name with the clip's key: a clip made the same way is the same file, so a map keeps the bytes
 * of one it already has (`withSounds`). When what a method does changes, this changes, and a map's files are made again.
 */
const ENGINE = "sound 2";

/** What the map's archive gets for a clip: a WAV's bytes now, or the samples of an Ogg Vorbis encoded when the map is built. */
export interface ClipFile {
  path: string;
  bytes?: Uint8Array;
  vorbis?: { rate: number; channels: readonly Float32Array[] };
}

/**
 * The file the map's archive gets for a clip, and the name it goes under: named by what the clip is (its key), so it
 * goes in once however often it is played, and the name is known without the samples. `contents`: the bytes (or, for
 * an Ogg, the samples to encode) too — a build's; a check, which the map does not get, leaves them out and makes none.
 */
export function clipFile(c: Clip, contents = true): ClipFile {
  const own = inside.get(c)!;
  if (!own.wav && !own.adpcm && c.seconds >= VORBIS_SECONDS) {
    const path = `staredit\\wav\\trigscript-${hashText(`${ENGINE}|vorbis ${VORBIS_QUALITY}|${keyOf(c)}`)}.ogg`;
    return contents ? { path, vorbis: { rate: c.rate, channels: samplesOf(c) } } : { path };
  }
  const path = `staredit\\wav\\trigscript-${hashText(`${ENGINE}|wav|${keyOf(c)}`)}.wav`;
  if (!contents) return { path };
  // An import as it was keeps its own ADPCM; anything else mono is ADPCM where that is faithful, 16-bit where not; two
  // channels are 16-bit.
  const channels = samplesOf(c);
  let bytes: Uint8Array;
  if (channels.length === 2) bytes = pcmWav(channels, c.rate);
  else {
    const coded = own.adpcm ?? encodeAdpcm(channels[0], c.rate);
    bytes = own.adpcm || adpcmWillDo(channels[0], c.rate, coded) ? adpcmWav(coded, c.rate, channels[0].length) : pcmWav(channels, c.rate);
  }
  return { path, bytes };
}

/** The value an import of a `.sound` file gives, kept while the text is the same (a build reads the files each time). */
const values = new Map<string, Clip>();

export function clipValue(text: string): Clip {
  const hit = values.get(text);
  if (hit) return hit;
  const d = readSound(text);
  const clip = makeClip(d.samples, d.rate, d.adpcm);
  if (values.size >= 16) values.delete(values.keys().next().value!);
  values.set(text, clip);
  return clip;
}

/* ── Clips from nothing ── */

const NOTE = /^([A-Ga-g])([#b]?)(-?\d)$/;
const SEMITONES: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** A pitch in hertz from a number or a note's name: "A4" is 440, "C#5", "Eb3". */
export function hertz(pitch: unknown): number {
  if (typeof pitch === "number") { if (!(pitch > 0 && pitch < 24000)) throw new RangeError(`A pitch is 0 to 24 000 Hz, not ${pitch}.`); return pitch; }
  const m = typeof pitch === "string" ? NOTE.exec(pitch.trim()) : null;
  if (!m) throw new Error(`A pitch is hertz or a note's name ("A4", "C#5", "Eb3"), not ${JSON.stringify(pitch)}.`);
  const midi = 12 * (Number(m[3]) + 1) + SEMITONES[m[1].toLowerCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  return 440 * 2 ** ((midi - 69) / 12);
}

interface MakeOptions { readonly volume?: number; readonly rate?: number }
const optionsOf = (o: MakeOptions | undefined, what: string) => {
  const volume = o?.volume ?? 0.5, rate = o?.rate ?? DEFAULT_RATE;
  if (!(volume >= 0 && volume <= 1)) throw new RangeError(`${what}'s volume is 0 to 1, not ${String(o?.volume)}.`);
  checkRate(rate);
  return { volume, rate };
};
const length = (seconds: unknown, what: string, rate: number) => {
  if (!(num(seconds, `${what}'s length`) > 0 && (seconds as number) <= MAX_SECONDS)) throw new RangeError(`${what} lasts more than 0 and at most ${MAX_SECONDS} seconds, not ${String(seconds)}.`);
  return Math.max(1, Math.round((seconds as number) * rate));
};

/** A pitch, or a glide, checked: hertz or a note's name, or [seconds, pitch] points (a kick's drop, a slide between notes). */
const pitchOf = (pitch: unknown, what: string): number | [number, number][] => {
  if (!Array.isArray(pitch)) return hertz(pitch);
  if (pitch.length === 0) throw new Error(`${what}'s pitch points are [seconds, pitch] pairs, one at least.`);
  return pitch.map((p, k) => {
    if (!Array.isArray(p) || p.length !== 2) throw new Error(`${what}'s pitch point ${k + 1} is [seconds, pitch].`);
    return [num(p[0], "a pitch point's seconds"), hertz(p[1])] as [number, number];
  });
};

type Wave = "sine" | "square" | "triangle" | "saw";
/** PolyBLEP: what rounds off a jump at phase 0 of a wave whose phase moves `dt` a sample. */
function blep(t: number, dt: number): number {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

/** One sample of a wave at phase `p` (0 … 1), `dt` the phase a sample moves: square and saw rounded off by PolyBLEP. */
function waveAt(wave: Wave, p: number, dt: number): number {
  switch (wave) {
    case "sine": return Math.sin(2 * Math.PI * p);
    case "square": { const q = p + 0.5; return (p < 0.5 ? 1 : -1) + blep(p, dt) - blep(q >= 1 ? q - 1 : q, dt); }
    case "triangle": return 1 - 4 * Math.abs(p - 0.5);
    case "saw": return 2 * p - 1 - blep(p, dt);
  }
}

/** A clip made from nothing by `op`: its arguments name it, its samples are worked out when they are asked for. */
const source = (op: string, args: unknown, rate: number, n: number, channels: 1 | 2, compute: () => Float32Array[]) => made(recipe(op, args), () => lazyClip(rate, n, channels, compute));

/**
 * A tone: `pitch` (hertz, a note's name, or [seconds, pitch] points to glide) for `seconds`, its wave's shape, 5 ms in
 * and out so it does not click. `voices`: that many copies, spread `detune` cents from lowest to highest, each from
 * its own phase — a supersaw, a wide pad — and `width` 0 … 1 spreads them left to right (two channels).
 */
export function tone(pitch: unknown, seconds: unknown, options?: MakeOptions & { readonly wave?: Wave; readonly voices?: number; readonly detune?: number; readonly width?: number }): Clip {
  const { volume, rate } = optionsOf(options, "tone()"), n = length(seconds, "tone()", rate);
  const wave = options?.wave ?? "sine";
  if (!["sine", "square", "triangle", "saw"].includes(wave)) throw new Error(`tone()'s wave is "sine", "square", "triangle" or "saw", not ${JSON.stringify(wave)}.`);
  const voices = options?.voices ?? 1, detune = options?.detune ?? (voices > 1 ? 20 : 0), width = options?.width ?? 0;
  if (!(Number.isInteger(voices) && voices >= 1 && voices <= 16)) throw new RangeError(`tone()'s voices is a whole number, 1 to 16, not ${voices}.`);
  if (!(num(detune, "tone()'s detune") >= 0 && detune <= 1200)) throw new RangeError(`tone()'s detune is 0 to 1 200 cents, not ${detune}.`);
  if (!(num(width, "tone()'s width") >= 0 && width <= 1)) throw new RangeError(`tone()'s width is 0 to 1, not ${width}.`);
  const p = pitchOf(pitch, "tone()"), stereo = voices > 1 && width > 0;
  return source("tone", [p, n, rate, wave, volume, voices, detune, width], rate, n, stereo ? 2 : 1, () => {
    const hz = curve(p, rate, n, true), ramp = 0.005 * rate;
    const L = new Float32Array(n), R = stereo ? new Float32Array(n) : L, random = seeded(0x51ed + voices);
    const one = voices === 1 ? 1 : 1 / Math.sqrt(voices);
    for (let v = 0; v < voices; v++) {
      const at = voices === 1 ? 0 : v / (voices - 1) - 0.5, ratio = 2 ** ((detune * at) / 1200);
      const pos = stereo ? width * 2 * at : 0, l = one * Math.min(1, 1 - pos), r = one * Math.min(1, 1 + pos);
      let ph = voices === 1 ? 0 : random();
      for (let i = 0; i < n; i++) {
        const dt = (hz[i] * ratio) / rate, x = waveAt(wave, ph, dt);
        if (stereo) { L[i] += l * x; R[i] += r * x; } else L[i] += one * x;
        ph += dt; ph -= Math.floor(ph);
      }
    }
    for (let i = 0; i < n; i++) {
      const g = volume * Math.min(1, i / ramp, (n - 1 - i) / ramp);
      L[i] *= g; if (stereo) R[i] *= g;
    }
    return stereo ? [L, R] : [L];
  });
}

/**
 * Two-operator FM — a sine whose phase another sine, `ratio` times its pitch, pushes by `index` (or [seconds, index]
 * points: bright at the start, mellow after). 1 a warm reed, 3.5 or 7 a bell, 0.5 a bass.
 */
export function fm(pitch: unknown, seconds: unknown, options?: MakeOptions & { readonly ratio?: number; readonly index?: number | readonly (readonly [number, number])[]; readonly feedback?: number }): Clip {
  const { volume, rate } = optionsOf(options, "fm()"), n = length(seconds, "fm()", rate);
  const ratio = options?.ratio ?? 1, index = options?.index ?? 2, feedback = options?.feedback ?? 0;
  if (!(num(ratio, "fm()'s ratio") > 0 && ratio <= 32)) throw new RangeError(`fm()'s ratio is more than 0, at most 32, not ${ratio}.`);
  if (!(num(feedback, "fm()'s feedback") >= 0 && feedback <= 2)) throw new RangeError(`fm()'s feedback is 0 to 2, not ${feedback}.`);
  if (typeof index !== "number" && !Array.isArray(index)) throw new Error("fm()'s index is a number or [seconds, index] points.");
  const p = pitchOf(pitch, "fm()");
  return source("fm", [p, n, rate, ratio, index, feedback, volume], rate, n, 1, () => {
    const out = fmVoice(curve(p, rate, n, true), rate, ratio, curve(index as number | Points, rate, n), feedback), ramp = 0.005 * rate;
    for (let i = 0; i < n; i++) out[i] *= volume * Math.min(1, i / ramp, (n - 1 - i) / ramp);
    return [out];
  });
}

/**
 * A plucked string (Karplus–Strong) — a guitar, a harp, a koto. `brightness` 0 … 1 (0.5), `decay` seconds to fade away
 * (2 when left out; the note ends at `seconds` regardless).
 */
export function pluck(pitch: unknown, seconds: unknown, options?: MakeOptions & { readonly brightness?: number; readonly decay?: number }): Clip {
  const { volume, rate } = optionsOf(options, "pluck()"), n = length(seconds, "pluck()", rate), hz = hertz(pitch);
  const brightness = options?.brightness ?? 0.5, decay = options?.decay ?? 2;
  if (!(num(brightness, "pluck()'s brightness") >= 0 && brightness <= 1)) throw new RangeError(`pluck()'s brightness is 0 to 1, not ${brightness}.`);
  if (!(num(decay, "pluck()'s decay") > 0)) throw new RangeError(`pluck()'s decay is seconds, more than 0, not ${decay}.`);
  if (hz < 20 || hz > rate / 4) throw new RangeError(`pluck() plays 20 Hz to a quarter of its rate, not ${hz.toFixed(0)} Hz.`);
  return source("pluck", [hz, n, rate, brightness, decay, volume], rate, n, 1, () => {
    const out = pluckVoice(hz, rate, n, brightness, decay), ramp = 0.003 * rate;
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
    for (let i = 0; i < n; i++) out[i] *= (volume / (peak || 1)) * Math.min(1, (n - 1 - i) / ramp);
    return [out];
  });
}

/** Noise for `seconds`: every sample a random one, the same on every build. */
export function noise(seconds: unknown, options?: MakeOptions): Clip {
  const { volume, rate } = optionsOf(options, "noise()"), n = length(seconds, "noise()", rate);
  return source("noise", [n, rate, volume], rate, n, 1, () => {
    let seed = 0x2545f491;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; out[i] = volume * ((seed >>> 0) / 0x80000000 - 1); }
    return [out];
  });
}

/** Nothing, for `seconds`: a gap to join between clips. */
export function silence(seconds: unknown, options?: { readonly rate?: number }): Clip {
  const { rate } = optionsOf(options, "silence()"), n = length(seconds, "silence()", rate);
  return source("silence", [n, rate], rate, n, 1, () => [new Float32Array(n)]);
}
