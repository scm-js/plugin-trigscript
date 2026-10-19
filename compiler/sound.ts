/**
 * Sounds a script imports or makes: `import boom from "./boom.sound"`, `tone("A4", 0.3)`. A `.sound` file is one of
 * the script's files, kept in the map with the others: the samples the editor decoded when it was imported, mono, at
 * the rate chosen, as IMA ADPCM — four bits a sample, the coding the game's own sounds use and the one the map gets.
 * The source file is not kept, as a video's and an image's are not: what the build reads is the same everywhere.
 *
 * What a script gets is a `Clip` (below), worked on when the script is built — trimmed, made louder or quieter,
 * faded, reversed, pitched, joined, mixed, repeated — or made from nothing by `tone`, `noise` and `silence`. A clip a
 * program plays (`playWav(boom)`) is written into the map's archive when the script is built, as a WAV named by what
 * it holds (`staredit\wav\trigscript-<hash>.wav`), once however often it is played; nothing else of it reaches the
 * game. The WAV is IMA ADPCM, a quarter of 16-bit, but for a tone the coding would make harsh, which goes in as
 * 16-bit PCM: ADPCM codes each sample as a step from the last, and the jumps of a square or a saw wave come back
 * ringing — 8 dB, heard as a harsh end to every note of the first sound demo (2026-10-19). See `adpcmWillDo`.
 *
 * What StarCraft: Remastered does with them (the sound probe, 2026-10-19): a sound starts on its mixer's 21.3 ms grid,
 * up to one buffer after its frame; playing one again starts a second copy beside the first, and nothing stops one,
 * so a note's length and loudness are its file's; 32 play at once; copies add, with no limiter; loudness is kept as
 * written. IMA ADPCM, PCM and Ogg Vorbis play; Ogg Opus does not.
 */
import { fromBase64, toBase64 } from "./rangeCoder";

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

/** A WAV of 16-bit PCM: what the map gets for a clip ADPCM would distort. */
export function pcmWav(samples: Float32Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2), v = new DataView(out.buffer);
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  text(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVE");
  text(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, "data"); v.setUint32(40, samples.length * 2, true);
  samples.forEach((x, i) => v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, x)) * 32767), true));
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

/** A sound when the script is built. `adpcm` is kept while a clip is its file's as it was, so the map gets those bytes. */
export interface Clip {
  readonly __trigscript: "clip";
  readonly seconds: number;
  readonly rate: number;
  /** The loudest sample, 0 … 1 (more than 1 clips when the map's file is written). */
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
}

interface ClipInside { samples: Float32Array; adpcm?: Uint8Array }
const inside = new WeakMap<Clip, ClipInside>();

export const isClip = (v: unknown): v is Clip => typeof v === "object" && v !== null && (v as Clip).__trigscript === "clip";

const num = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what} is a number, not ${String(v)}.`);
  return v;
};

/** `samples` at `rate`, as a rate of its own, by straight lines between samples. */
function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const n = Math.max(1, Math.round((samples.length * to) / from)), out = new Float32Array(n), r = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * r, a = Math.floor(p), f = p - a;
    out[i] = (samples[a] ?? 0) * (1 - f) + (samples[a + 1] ?? samples[a] ?? 0) * f;
  }
  return out;
}

/** The clip these samples are. */
export function makeClip(samples: Float32Array, rate: number, adpcm?: Uint8Array): Clip {
  if (samples.length / rate > MAX_SECONDS) throw new Error(`A clip is at most ${MAX_SECONDS / 60} minutes long, not ${(samples.length / rate / 60).toFixed(1)}.`);
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const seconds = samples.length / rate;
  const at = (t: number) => Math.max(0, Math.min(samples.length, Math.round(t * rate)));
  const map = (f: (s: number, i: number) => number) => makeClip(samples.map(f), rate);
  const clip: Clip = {
    __trigscript: "clip",
    seconds,
    rate,
    peak,
    trim(from, to = seconds) {
      num(from, "trim()'s start"); num(to, "trim()'s end");
      if (from < 0 || to > seconds + 1e-9 || to <= from) throw new RangeError(`trim(${from}, ${to}) is not inside the clip, which is ${seconds.toFixed(3)} seconds.`);
      return makeClip(samples.slice(at(from), at(to)), rate);
    },
    gain(factor) {
      if (num(factor, "gain()") < 0) throw new RangeError(`gain() is 0 or more (0.5 half as loud, 2 twice), not ${factor}.`);
      return map((s) => s * factor);
    },
    fade(fadeIn, fadeOut = 0) {
      num(fadeIn, "fade()'s in"); num(fadeOut, "fade()'s out");
      if (fadeIn < 0 || fadeOut < 0) throw new RangeError("fade() takes seconds, 0 or more.");
      const a = fadeIn * rate, b = fadeOut * rate, n = samples.length;
      return map((s, i) => s * Math.min(1, a ? i / a : 1, b ? (n - 1 - i) / b : 1));
    },
    reverse() { return makeClip(samples.slice().reverse(), rate); },
    pitch(semitones) {
      // Faster and higher, or slower and lower, as a sampler plays a note: the clip read at another speed.
      const ratio = 2 ** (num(semitones, "pitch()") / 12);
      return makeClip(resample(samples, rate * ratio, rate), rate);
    },
    then(...clips) {
      const parts = [samples, ...clips.map((c) => { if (!isClip(c)) throw new Error("then() joins clips."); return resample(inside.get(c)!.samples, c.rate, rate); })];
      const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return makeClip(out, rate);
    },
    mix(other, start = 0) {
      if (!isClip(other)) throw new Error("mix() takes a clip.");
      if (num(start, "mix()'s start") < 0) throw new RangeError("mix()'s start is 0 seconds or more.");
      const o = resample(inside.get(other)!.samples, other.rate, rate), from = Math.round(start * rate);
      const out = new Float32Array(Math.max(samples.length, from + o.length));
      out.set(samples);
      for (let i = 0; i < o.length; i++) out[from + i] += o[i];
      return makeClip(out, rate);
    },
    envelope(...points) {
      // Loudness through the clip, a straight line between [seconds, level] points: the first level before the first,
      // the last after the last.
      if (points.length === 0) throw new Error("envelope() takes [seconds, level] points: envelope([0, 0], [0.01, 1], [0.3, 0]).");
      const ps = points.map((p, k) => {
        if (!Array.isArray(p) || p.length !== 2) throw new Error(`envelope()'s point ${k + 1} is [seconds, level].`);
        return [num(p[0], "a point's seconds") * rate, num(p[1], "a point's level")] as const;
      });
      for (let k = 1; k < ps.length; k++) if (ps[k][0] < ps[k - 1][0]) throw new RangeError("envelope()'s points go forward in time.");
      let k = 0;
      return map((v, i) => {
        while (k < ps.length && ps[k][0] <= i) k++;
        const level = k === 0 ? ps[0][1] : k === ps.length ? ps[k - 1][1] : ps[k - 1][1] + ((ps[k][1] - ps[k - 1][1]) * (i - ps[k - 1][0])) / (ps[k][0] - ps[k - 1][0] || 1);
        return v * level;
      });
    },
    repeat(times) {
      if (!Number.isInteger(num(times, "repeat()")) || times < 1) throw new RangeError(`repeat() takes a whole number of times, 1 or more, not ${times}.`);
      const out = new Float32Array(samples.length * times);
      for (let k = 0; k < times; k++) out.set(samples, k * samples.length);
      return makeClip(out, rate);
    },
  };
  inside.set(clip, { samples, ...(adpcm ? { adpcm } : {}) });
  return Object.freeze(clip);
}

/**
 * Many clips laid over one another, each from its own time (seconds), as one clip at the first's rate: what a song
 * sounds like when it is mixed when the script is built. `seconds` makes it that long at least.
 */
export function mixdown(parts: unknown, seconds?: unknown): Clip {
  if (!Array.isArray(parts) || parts.length === 0) throw new Error("mixdown() takes { clip, at } parts, one at least.");
  const list = parts.map((p, k) => {
    const c = (p as { clip?: unknown })?.clip, at = (p as { at?: unknown })?.at ?? 0;
    if (!isClip(c)) throw new Error(`mixdown()'s part ${k + 1} has no clip.`);
    if (num(at, "a part's time") < 0) throw new RangeError("A part's time is 0 seconds or more.");
    return { c, at: at as number };
  });
  const rate = list[0].c.rate;
  const length = Math.max(seconds === undefined ? 0 : Math.round(num(seconds, "mixdown()'s length") * rate), ...list.map((p) => Math.round(p.at * rate) + Math.round(p.c.seconds * rate)));
  if (length / rate > MAX_SECONDS) throw new RangeError(`A clip is at most ${MAX_SECONDS / 60} minutes long.`);
  const out = new Float32Array(length);
  for (const p of list) {
    const s = resample(inside.get(p.c)!.samples, p.c.rate, rate), from = Math.round(p.at * rate);
    for (let i = 0; i < s.length && from + i < length; i++) out[from + i] += s[i];
  }
  return makeClip(out, rate);
}

/** A clip's samples (for the compiler's own work and the editor's player, not in the declarations). */
export const clipSamples = (c: Clip): Float32Array => inside.get(c)!.samples;

/** The WAV the map's archive gets for a clip, and the name it goes under: named by what it holds, so it goes in once. */
export function clipFile(c: Clip): { path: string; bytes: Uint8Array } {
  const { samples, adpcm } = inside.get(c)!;
  // An import as it was keeps its own ADPCM; anything else is ADPCM where that is faithful, 16-bit where not.
  const coded = adpcm ?? encodeAdpcm(samples, c.rate);
  const bytes = adpcm || adpcmWillDo(samples, c.rate, coded) ? adpcmWav(coded, c.rate, samples.length) : pcmWav(samples, c.rate);
  // FNV-1a over the file: two clips that are the same file share it.
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return { path: `staredit\\wav\\trigscript-${h.toString(16).padStart(8, "0")}.wav`, bytes };
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

/** A tone: `pitch` (hertz or a note's name) for `seconds`, its wave's shape, 5 ms in and out so it does not click. */
export function tone(pitch: unknown, seconds: unknown, options?: MakeOptions & { readonly wave?: "sine" | "square" | "triangle" | "saw" }): Clip {
  const { volume, rate } = optionsOf(options, "tone()"), hz = hertz(pitch), n = length(seconds, "tone()", rate);
  const wave = options?.wave ?? "sine";
  // Square and saw with their jumps rounded off by PolyBLEP, so nothing above half the rate folds back as other pitches.
  const dt = hz / rate;
  const blep = (t: number) => (t < dt ? ((t /= dt), t + t - t * t - 1) : t > 1 - dt ? ((t = (t - 1) / dt), t * t + t + t + 1) : 0);
  const shape = {
    sine: (p: number) => Math.sin(2 * Math.PI * p),
    square: (p: number) => (p < 0.5 ? 1 : -1) + blep(p) - blep((p + 0.5) % 1),
    triangle: (p: number) => 1 - 4 * Math.abs(p - 0.5),
    saw: (p: number) => 2 * p - 1 - blep(p),
  }[wave];
  if (!shape) throw new Error(`tone()'s wave is "sine", "square", "triangle" or "saw", not ${JSON.stringify(wave)}.`);
  const out = new Float32Array(n), ramp = 0.005 * rate;
  for (let i = 0; i < n; i++) out[i] = volume * shape((i * hz / rate) % 1) * Math.min(1, i / ramp, (n - 1 - i) / ramp);
  return makeClip(out, rate);
}

/** Noise for `seconds`: every sample a random one, the same on every build. */
export function noise(seconds: unknown, options?: MakeOptions): Clip {
  const { volume, rate } = optionsOf(options, "noise()"), n = length(seconds, "noise()", rate);
  let seed = 0x2545f491;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; out[i] = volume * ((seed >>> 0) / 0x80000000 - 1); }
  return makeClip(out, rate);
}

/** Nothing, for `seconds`: a gap to join between clips. */
export function silence(seconds: unknown, options?: { readonly rate?: number }): Clip {
  const { rate } = optionsOf(options, "silence()");
  return makeClip(new Float32Array(length(seconds, "silence()", rate)), rate);
}
