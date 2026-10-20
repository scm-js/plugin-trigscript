/**
 * Music in a program: the standard library's "trigscript/music" (TrigScript 4).
 *
 *   import { music } from "trigscript/music";
 *   import pluck from "./pluck.sound";
 *
 *   const lead = music.synth({ wave: "square", volume: 0.2 });
 *   const bass = music.sampler(pluck, "A3");
 *   const drums = music.kit({ k: kick, s: snare, h: hat });
 *
 *   const song = music.song({ bpm: 120 },
 *     music.track(lead,  "C5 - E5 - G5 - - . | A5 - G5 - E5 - - ."),
 *     music.track(bass,  "C3 - - - - - - - | F3 - - - - - - -"),
 *     music.track(drums, "kh h sh h kh h sh h | kh h sh h kh kh sh h"),
 *   );
 *
 *   program(async () => {
 *     start(music.loop(song));          // the song again and again, beside the program
 *     playWav(lead.note("C6", 0.1));     // an instrument's note on its own, for a sound effect
 *   });
 *
 * A pattern is steps, a word each, a quarter of a beat each by default: a note's name starts it ("C4", "F#5", "Bb2"),
 * several with + sound together ("C4+E4+G4"), "-" holds what sounds a step longer, "." is a rest, "|" is only for the
 * eye; "@" after a step's notes says how loud ("C4@0.5"). A kit's step is its sounds' letters ("kh": kick and hat).
 * Everything is worked out when the script is built: each note an instrument plays becomes a clip once (`trigscript`'s
 * Clip, put in the map once however often it plays), and the song a table of which clip starts on which frame, which
 * `play` reads while the game runs.
 *
 * A longer song is written in sections — parts named once, each section saying what they play in it, a pattern played
 * again until the section is full — and chords by name, their notes drawn by a template:
 *
 *   const parts = { keys: music.part(music.presets.keys()), bass: music.part(music.presets.bass()), drums: music.part(music.drums()) };
 *   const verse = music.section(4, {
 *     keys: music.chords("Am F C G", "1+2+3 - . 1+2+3 . . 1+2+3 -", { octave: 4, lead: true }),
 *     bass: music.chords("Am F C G", "1 - . 1 . 1 3 -", { octave: 2 }),
 *     drums: music.beat({ k: [0, 3, 4], s: [2, 6], h: [0, 1, 2, 3, 4, 5, 6, 7] }, 8),
 *   });
 *   const song = music.arrange({ bpm: 120, steps: 2 }, parts, intro, verse, verse.with({ keys: null }), outro);
 *
 * Music that follows the game is a song of sections cut into bars and layers, a clip each, which the program steers
 * bar by bar — which section, which layers, a stinger on the next beat:
 *
 *   const cut = music.stems(song, { layers: { drums: ["drums"], rest: ["keys", "bass"] } });
 *   program(async () => {
 *     const band = new Band();                    // import { music, Band } from "trigscript/music"
 *     start(music.conduct(cut, band));
 *     if (danger) band.go(cut.section("chorus")); // at the next bar line
 *     if (cleared) band.sting(cut.stinger("crash")); // on the next beat
 *   });
 *
 * What the game does with it (the sound probe, 2026-10-19): a bar is a whole number of frames (42 ms on Fastest), so
 * the tempo is the nearest that fits — `song.bpm` says which; a sound starts within 21 ms of its frame; 32 sound at
 * once, and a song that would need more is refused; notes that overlap add, with no limiter, so keep the volumes down.
 * `render` mixes a song into one clip when the script is built instead: every note exactly in time, one sound playing,
 * nothing to change while it plays. A program plays to its own player; a program for each player plays to each.
 */
import { game, sleep, frames, playWav, tone, noise, fm, pluck, mixdown, together, memory, type Clip, type Notes } from "trigscript";

/** Seconds a frame lasts on Fastest, the speed a map is played at. */
const FRAME = 0.042;
/** Sounds the game plays at once. */
const VOICES = 32;

/** What plays a pattern's notes: each note a clip, made when the script is built. */
export interface Instrument {
  readonly kind: "notes";
  /**
   * Note `name` ("C4", "F#5") lasting `seconds`, release and all: a clip to play on its own, too. `rate`: samples a
   * second, for an instrument that makes its notes (render asks for 44 100).
   */
  note(name: string, seconds: number, rate?: number): Clip;
}

/** What plays a pattern's letters: a clip a letter. */
export interface Kit {
  readonly kind: "kit";
  readonly hits: Readonly<Record<string, Clip>>;
}

const SEMITONE: Readonly<Record<string, number>> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** A note's number, 69 for A4: "C4" is 60, "C#4" 61, "Db4" 61. */
function noteNumber(name: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`A note is a name with its octave — "C4", "F#5", "Bb2" — not ${JSON.stringify(name)}.`);
  return 12 * (Number(m[3]) + 1) + SEMITONE[m[1].toLowerCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
}

/** Notes kept as they are made, so a note played many times is the same clip (and the same file in the map). */
function remembering(make: (name: string, seconds: number, rate?: number) => Clip): (name: string, seconds: number, rate?: number) => Clip {
  const made = new Map<string, Clip>();
  return (name, seconds, rate) => {
    const key = `${name} ${seconds.toFixed(4)} ${rate ?? ""}`;
    let c = made.get(key);
    if (!c) { c = make(name, seconds, rate); made.set(key, c); }
    return c;
  };
}

/**
 * An instrument from a recording of one note, `root` ("A3"): every other note is it played faster or slower, as a
 * sampler does, cut to the note's length with a short release. Where the recording is shorter than a note, the note
 * is as long as the recording.
 */
export function sampler(clip: Clip, root: string = "C4", options: { readonly release?: number; readonly volume?: number } = {}): Instrument {
  const base = noteNumber(root), release = options.release ?? 0.05, volume = options.volume ?? 1;
  return Object.freeze({
    kind: "notes" as const,
    note: remembering((name, seconds) => {
      const pitched = clip.pitch(noteNumber(name) - base).gain(volume);
      return pitched.trim(0, Math.min(pitched.seconds, seconds)).fade(0, Math.min(release, seconds / 2));
    }),
  });
}

/** An attack, a decay to the sustain level, and a release after the note's length, in seconds (sustain 0 … 1). */
export interface Shape { readonly attack?: number; readonly decay?: number; readonly sustain?: number; readonly release?: number }

/** A shape's points for a note held `held` seconds, as levels 0 … 1: the attack from 0, the release to 0. */
function shapePoints(shape: Required<Shape>, held: number): [number, number][] {
  const { attack, decay, sustain, release } = shape;
  const h = Math.max(attack + decay, held);
  return [[0, 0], [attack, 1], [attack + decay, sustain], [h, sustain], [h + release, 0]];
}
const full = (s: Shape | undefined, d: Required<Shape>): Required<Shape> => ({ attack: s?.attack ?? d.attack, decay: s?.decay ?? d.decay, sustain: s?.sustain ?? d.sustain, release: s?.release ?? d.release });

/** A synth's filter: its type, the cutoff it rests at, its resonance, and how many octaves above it a note's envelope opens it. */
export interface SynthFilter {
  readonly type?: "lowpass" | "highpass" | "bandpass";
  readonly cutoff: number;
  readonly resonance?: number;
  /** Octaves above the cutoff at the envelope's top (0: the filter does not move). */
  readonly amount?: number;
  /** The filter's own attack, decay, sustain and release, as a note's loudness has. */
  readonly envelope?: Shape;
}

export interface SynthOptions extends Shape {
  readonly wave?: "sine" | "square" | "triangle" | "saw";
  readonly volume?: number;
  /** Copies of each note (1 to 16), `detune` cents apart from lowest to highest, `width` 0 … 1 across left and right. */
  readonly voices?: number;
  readonly detune?: number;
  readonly width?: number;
  readonly filter?: SynthFilter;
  /** Saturation after the filter, dB of push (`Clip.drive`). */
  readonly drive?: number;
  /** Semitones each note slides up from (a negative number: from below) over `glideTime` seconds. */
  readonly glide?: number;
  readonly glideTime?: number;
}

/**
 * An instrument made of tones: `wave` ("sine", "square", "triangle", "saw") shaped by an attack, a decay to the
 * sustain level, and a release after the note's length — a stack of detuned copies with `voices`, through a filter
 * that opens and closes with each note with `filter`, saturated with `drive`.
 */
export function synth(options: SynthOptions = {}): Instrument {
  const wave = options.wave ?? "square", volume = options.volume ?? 0.2;
  const amp = full(options, { attack: 0.005, decay: 0.08, sustain: 0.7, release: 0.06 });
  const f = options.filter, fshape = full(f?.envelope, { attack: 0.005, decay: 0.25, sustain: 0.2, release: 0.2 });
  const voices = options.voices ?? 1, detune = options.detune ?? (voices > 1 ? 20 : 0), width = options.width ?? 0;
  return Object.freeze({
    kind: "notes" as const,
    note: remembering((name, seconds, rate) => {
      const held = Math.max(amp.attack + amp.decay, seconds - amp.release), length = held + amp.release;
      const r = rate === undefined ? {} : { rate };
      const pitch = options.glide ? [[0, 440 * 2 ** ((noteNumber(name) + options.glide - 69) / 12)], [options.glideTime ?? 0.06, name]] as [number, number | string][] : name;
      let c = tone(pitch, length, { wave, volume, voices, detune, width, ...r });
      if (f) {
        const amount = f.amount ?? 0, base = f.cutoff;
        const cutoff = amount === 0 ? base : shapePoints(fshape, held).map(([t, level]) => [t, base * 2 ** (amount * level)] as [number, number]);
        c = c.filter(f.type ?? "lowpass", cutoff, { resonance: f.resonance ?? 0.1 });
      }
      if (options.drive) c = c.drive(options.drive);
      return c.envelope(...shapePoints(amp, held));
    }),
  });
}

/**
 * An FM instrument (`fm()`): `ratio` the modulator's pitch to the note's, `index` how bright a note starts, falling to
 * `index × brightness` over `bright` seconds — an electric piano (ratio 1), a bell (3.5), a bass (0.5).
 */
export function fmSynth(options: Shape & { readonly ratio?: number; readonly index?: number; readonly brightness?: number; readonly bright?: number; readonly feedback?: number; readonly volume?: number } = {}): Instrument {
  const amp = full(options, { attack: 0.002, decay: 1.2, sustain: 0.35, release: 0.3 });
  const ratio = options.ratio ?? 1, index = options.index ?? 3, after = index * (options.brightness ?? 0.2), bright = options.bright ?? 0.8, volume = options.volume ?? 0.25;
  return Object.freeze({
    kind: "notes" as const,
    note: remembering((name, seconds, rate) => {
      const held = Math.max(amp.attack + amp.decay, seconds - amp.release), length = held + amp.release;
      return fm(name, length, { ratio, index: [[0, index], [bright, after]], feedback: options.feedback ?? 0, volume, ...(rate === undefined ? {} : { rate }) }).envelope(...shapePoints(amp, held));
    }),
  });
}

/** A plucked-string instrument (`pluck()`): `brightness` 0 … 1, `decay` seconds; a note rings out its decay unless `cut`. */
export function strings(options: { readonly brightness?: number; readonly decay?: number; readonly volume?: number; readonly cut?: boolean } = {}): Instrument {
  const brightness = options.brightness ?? 0.55, decay = options.decay ?? 1.5, volume = options.volume ?? 0.3;
  return Object.freeze({
    kind: "notes" as const,
    note: remembering((name, seconds, rate) => {
      const length = options.cut ? seconds + 0.05 : Math.max(seconds + 0.05, Math.min(decay, 4));
      return pluck(name, length, { brightness, decay, volume, ...(rate === undefined ? {} : { rate }) }).fade(0, 0.05);
    }),
  });
}

/**
 * Instruments to start from, each a function that takes the same options as the instrument it is made with, over its
 * own: `music.presets.supersaw({ volume: 0.1 })`.
 */
export const presets = {
  /** Seven detuned saws through a filter that opens on each note: a trance lead, big chords. */
  supersaw: (o: SynthOptions = {}) => synth({ wave: "saw", voices: 7, detune: 28, width: 0.7, volume: 0.16, attack: 0.005, decay: 0.25, sustain: 0.8, release: 0.18, filter: { cutoff: 1800, amount: 2, resonance: 0.15, envelope: { decay: 0.35, sustain: 0.35 } }, ...o }),
  /** A slow, wide pad: five saws, the filter low and slowly opening. Give its track a chorus and the reverb. */
  pad: (o: SynthOptions = {}) => synth({ wave: "saw", voices: 5, detune: 18, width: 1, volume: 0.1, attack: 0.35, decay: 0.6, sustain: 0.85, release: 0.8, filter: { cutoff: 700, amount: 1.3, resonance: 0.1, envelope: { attack: 0.6, decay: 1.2, sustain: 0.5, release: 0.8 } }, ...o }),
  /** A round, punchy bass: two saws, the filter snapping shut after each note, a little drive. */
  bass: (o: SynthOptions = {}) => synth({ wave: "saw", voices: 2, detune: 8, volume: 0.32, attack: 0.002, decay: 0.12, sustain: 0.9, release: 0.04, filter: { cutoff: 180, amount: 2.6, resonance: 0.25, envelope: { decay: 0.18, sustain: 0.15, release: 0.05 } }, drive: 6, ...o }),
  /** A squelchy, resonant line (a 303's): one saw, the filter wide open on each note and shutting fast. */
  acid: (o: SynthOptions = {}) => synth({ wave: "saw", volume: 0.22, attack: 0.002, decay: 0.1, sustain: 0.8, release: 0.05, filter: { cutoff: 260, amount: 3.6, resonance: 0.82, envelope: { decay: 0.16, sustain: 0 } }, drive: 10, ...o }),
  /** A warm lead: two square waves a little apart, softened by a filter. */
  lead: (o: SynthOptions = {}) => synth({ wave: "square", voices: 2, detune: 12, width: 0.3, volume: 0.15, attack: 0.004, decay: 0.15, sustain: 0.7, release: 0.12, filter: { cutoff: 2200, amount: 1.2, resonance: 0.2, envelope: { decay: 0.25, sustain: 0.4 } }, ...o }),
  /** The old consoles' lead: a bare square wave. */
  chip: (o: SynthOptions = {}) => synth({ wave: "square", volume: 0.14, attack: 0.002, decay: 0.05, sustain: 0.8, release: 0.03, ...o }),
  /** An electric piano: FM at ratio 1, bright on the strike and mellowing. */
  keys: (o: Parameters<typeof fmSynth>[0] = {}) => fmSynth({ ratio: 1, index: 2.6, brightness: 0.25, bright: 0.6, volume: 0.22, decay: 1.4, sustain: 0.3, release: 0.35, ...o }),
  /** A bell: FM at ratio 3.5, long and shimmering. */
  bell: (o: Parameters<typeof fmSynth>[0] = {}) => fmSynth({ ratio: 3.5, index: 5, brightness: 0.08, bright: 1.6, volume: 0.16, decay: 2.5, sustain: 0, release: 1.2, ...o }),
  /** A plucked string, a little bright. */
  pluck: (o: Parameters<typeof strings>[0] = {}) => strings({ brightness: 0.6, decay: 1.4, ...o }),
};

/**
 * A drum kit made from nothing, a letter a drum: k kick, s snare, c clap, h closed hat, o open hat, t tom, r rim, x crash. At
 * 44 100 Hz (`rate`), so the hats keep their top; `volume` 0 … 1 over the whole kit (1).
 */
export function drums(options: { readonly rate?: number; readonly volume?: number } = {}): Kit {
  const rate = options.rate ?? 44100, v = options.volume ?? 1;
  const metal = (seconds: number) => [263, 400, 421, 474, 587, 845].map((hz) => tone(hz * 2.6, seconds, { wave: "square", volume: 0.16, rate })).reduce((a, b) => a.mix(b));
  const kick = tone([[0, 170], [0.025, 85], [0.3, 46]], 0.42, { volume: 0.95, rate }).envelope([0, 1], [0.08, 0.85], [0.42, 0])
    .mix(noise(0.006, { volume: 0.35, rate }).filter("highpass", 3000)).drive(5);
  const snare = tone([[0, 260], [0.04, 185]], 0.18, { wave: "triangle", volume: 0.6, rate }).envelope([0, 1], [0.15, 0])
    .mix(noise(0.28, { volume: 0.6, rate }).filter("highpass", 1400).filter("peak", 5000, { gain: 4 }).envelope([0, 1], [0.03, 0.55], [0.26, 0])).drive(4);
  const burst = (at: number) => ({ clip: noise(0.012, { volume: 0.6, rate }).envelope([0, 1], [0.012, 0.2]), at });
  const clap = mixdown([burst(0), burst(0.011), burst(0.023), { clip: noise(0.22, { volume: 0.5, rate }).envelope([0, 1], [0.22, 0]), at: 0.03 }], undefined, rate)
    .filter("bandpass", 1300, { resonance: 0.35 }).gain(1.6);
  const hat = (seconds: number) => metal(seconds).mix(noise(seconds, { volume: 0.4, rate })).filter("highpass", 7200).filter("highshelf", 10000, { gain: 3 }).envelope([0, 1], [seconds * 0.25, 0.4], [seconds, 0]);
  const tom = tone([[0, 190], [0.2, 120]], 0.4, { volume: 0.8, rate }).envelope([0, 1], [0.4, 0]).mix(noise(0.01, { volume: 0.2, rate }).filter("bandpass", 2500));
  const rim = tone(1700, 0.025, { wave: "triangle", volume: 0.5, rate }).mix(noise(0.012, { volume: 0.3, rate }).filter("highpass", 4000)).envelope([0, 1], [0.025, 0]);
  const crash = metal(2).mix(noise(2, { volume: 0.5, rate })).filter("highpass", 4500).filter("peak", 7500, { gain: 3 }).envelope([0, 1], [0.08, 0.5], [2, 0]);
  return kit({ k: kick.gain(v), s: snare.gain(v), c: clap.gain(v), h: hat(0.07).gain(0.55 * v), o: hat(0.4).gain(0.5 * v), t: tom.gain(v), r: rim.gain(v), x: crash.gain(0.45 * v) });
}

/** A kit: a clip a letter, played by a pattern's letters ("kh" plays k and h together). */
export function kit(hits: Readonly<Record<string, Clip>>): Kit {
  for (const k of Object.keys(hits)) if (k.length !== 1 || k === "." || k === "-" || k === "|") throw new Error(`A kit's sounds are named by one letter each, not ${JSON.stringify(k)}.`);
  return Object.freeze({ kind: "kit" as const, hits: Object.freeze({ ...hits }) });
}

/* ── Patterns: what is written, and what writes it ── */

/** A pattern: steps a word each, as one text or a text a bar. */
export type Pattern = string | readonly string[];

/** A pattern's steps, the "|" left out. */
const wordsOf = (p: Pattern): string[] => (typeof p === "string" ? p : p.join(" ")).split(/\s+/).filter((w) => w !== "" && w !== "|");

/** A step's sounds and how loud: "C4+E4@0.6" is C4 and E4 at 0.6; "kh" k and h at 1. */
function velocityOf(word: string, step: number): { body: string; velocity: number } {
  const at = word.indexOf("@");
  if (at < 0) return { body: word, velocity: 1 };
  const body = word.slice(0, at), v = Number(word.slice(at + 1));
  if (body === "" || body === "-" || body === "." || !(v >= 0 && v <= 4)) throw new Error(`Step ${step + 1}: "@" follows a note, a chord or a kit's letters, with how loud they play, 0 to 4 (1 as written): "C4@0.6", "kh@1.3" — not ${JSON.stringify(word)}.`);
  return { body, velocity: v };
}

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
/** A note's name from its number: 60 is "C4". Sharps, not flats. */
function nameOf(n: number): string {
  const octave = Math.floor(n / 12) - 1;
  if (octave < -1 || octave > 9) throw new Error(`A note goes from C-1 to B9: this one would be ${NAMES[((n % 12) + 12) % 12]}${octave}.`);
  return NAMES[((n % 12) + 12) % 12] + octave;
}

/** Each note of a step moved by a function of its number; holds, rests, kit letters and "@" kept. */
const eachNote = (p: Pattern, move: (n: number) => number): string[] => wordsOf(p).map((w) => w.replace(/[A-Ga-g][#b]?-?\d/g, (name) => nameOf(move(noteNumber(name)))));

/** A pattern `semitones` up (or down: a negative number): `transpose(tune, 12)` is the tune an octave up. A text a bar stays a text a bar. */
export function transpose(p: Pattern, semitones: number): Pattern {
  if (!Number.isInteger(semitones)) throw new Error(`transpose() moves by whole semitones, not ${semitones}.`);
  if (semitones === 0) return p;
  return typeof p === "string" ? eachNote(p, (n) => n + semitones).join(" ") : p.map((bar) => eachNote(bar, (n) => n + semitones).join(" "));
}

/** A pattern with each step `by` steps long — eighths written as sixteenths with `stretch(p, 2)`. A text a bar stays a text a bar. */
export function stretch(p: Pattern, by: number): Pattern {
  if (!Number.isInteger(by) || by < 1) throw new Error(`stretch() makes each step a whole number of steps long, 1 or more — not ${by}.`);
  const one = (text: string) => wordsOf(text).map((w) => [w, ...Array.from({ length: by - 1 }, () => (w.startsWith(".") ? "." : "-"))].join(" ")).join(" ");
  return typeof p === "string" ? one(p) : p.map(one);
}

/** A pattern `n` times over, as one text. */
export function repeat(p: Pattern, n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new Error(`repeat() plays a pattern a whole number of times, 1 or more — not ${n}.`);
  return Array.from({ length: n }, () => wordsOf(p).join(" ")).join(" ");
}

/** A kit's bar: the steps (from 0) each letter plays on, `steps` steps long — `beat({ k: [0, 8], s: [4, 12] })`. */
export function beat(hits: Readonly<Record<string, readonly number[]>>, steps: number = 16): string {
  for (const [k, at] of Object.entries(hits)) for (const s of at) if (!Number.isInteger(s) || s < 0 || s >= steps) throw new Error(`beat(): ${k} on step ${s}, of steps 0 to ${steps - 1}.`);
  return Array.from({ length: steps }, (_, i) => Object.keys(hits).filter((k) => hits[k].includes(i)).join("") || ".").join(" ");
}

/** A chord's notes above its root, by what follows the root's name. */
const QUALITIES: Readonly<Record<string, readonly number[]>> = {
  "": [0, 4, 7], m: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], "+": [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7], sus: [0, 5, 7], "5": [0, 7],
  "6": [0, 4, 7, 9], m6: [0, 3, 7, 9], "7": [0, 4, 7, 10], maj7: [0, 4, 7, 11], M7: [0, 4, 7, 11], m7: [0, 3, 7, 10], dim7: [0, 3, 6, 9],
  m7b5: [0, 3, 6, 10], "7sus4": [0, 5, 7, 10], "9": [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14],
};

/** A chord's notes as numbers, lowest first. */
function chordNumbers(symbol: string, octave: number, inversion: number): number[] {
  const m = /^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/.exec(symbol);
  const steps = m ? QUALITIES[m[2]] : undefined;
  if (!m || !steps) throw new Error(`A chord is a root and what kind — "Am", "C", "G7", "Fmaj7", "Dm7", "Esus4", "Bdim", "C/E" — not ${JSON.stringify(symbol)}. The kinds: ${Object.keys(QUALITIES).map((q) => `"${q}"`).join(", ")}.`);
  if (!Number.isInteger(inversion) || inversion < 0 || inversion >= steps.length) throw new Error(`${symbol} has ${steps.length} notes: its inversion is 0 to ${steps.length - 1}, not ${inversion}.`);
  const root = noteNumber(m[1] + octave);
  const notes = steps.map((s) => root + s);
  for (let k = 0; k < inversion; k++) notes.push(notes.shift()! + 12);
  if (m[3]) {
    // Over another bass: that note, below the rest.
    let bass = noteNumber(m[3] + octave);
    while (bass >= notes[0]) bass -= 12;
    notes.unshift(bass);
  }
  return notes;
}

/**
 * A chord's notes, as a step plays them: `chord("Am")` is "A4+C5+E5", its root in octave 4 (`octave`); `inversion`
 * moves its lowest notes up an octave, one each — `chord("E", 3, 1)` is "G#3+B3+E4". "C/E" is C over an E below it.
 */
export function chord(symbol: string, octave: number = 4, inversion: number = 0): string {
  return chordNumbers(symbol, octave, inversion).map(nameOf).join("+");
}

/** Each chord's notes as numbers, lowest first: the ones written, or the symbol's at `octave`. */
const notesOf = (c: string, octave: number): number[] => (/\d/.test(c) ? c.split("+").map(noteNumber).sort((a, b) => a - b) : chordNumbers(c, octave, 0));

/**
 * A chord played as `template` says: its steps name the chord's notes by number, 1 the lowest — "1 3 2 3", "1+2+3 - - -"
 * — past the last, round again an octave up (in a three-note chord, 4 is 1 an octave up); each ^ after a number takes it
 * an octave higher, each _ an octave lower ("1__" the root two octaves down, for a bass). "-", "." and "@" as in any
 * pattern. `notes` is a chord's notes ("A3+C4+E4") or its name ("Am", with its root in octave `octave`).
 */
export function over(notes: string, template: Pattern, octave: number = 4): string {
  const n = notesOf(notes, octave);
  return wordsOf(template).map((w, s) => {
    const { body, velocity } = velocityOf(w, s);
    if (body === "-" || body === ".") return w;
    const named = body.split("+").map((d) => {
      const m = /^(\d+)([\^_]*)$/.exec(d);
      if (!m || Number(m[1]) < 1) throw new Error(`Step ${s + 1} of a chord's template: its notes are numbers from 1, the lowest, with ^ or _ for an octave up or down — "1", "3^", "1__" — not ${JSON.stringify(d)}.`);
      const k = Number(m[1]) - 1, up = Math.floor(k / n.length) + (m[2].match(/\^/g)?.length ?? 0) - (m[2].match(/_/g)?.length ?? 0);
      return nameOf(n[k % n.length] + 12 * up);
    });
    return named.join("+") + (velocity === 1 ? "" : `@${velocity}`);
  }).join(" ");
}

/**
 * A progression played as `template` says, a template a chord: `chords("Am Am E Am Dm C E Am", "1_ 1 2 3")` — as
 * `over` plays one chord. Each chord's root in octave `octave` (4); `lead: true` turns each chord after the first to
 * the inversion nearest the one before (its notes move least), as a player's hands do. A text a chord.
 */
export function chords(progression: string | readonly string[], template: Pattern, options: { readonly octave?: number; readonly lead?: boolean } = {}): string[] {
  const octave = options.octave ?? 4, list = wordsOf(progression);
  let before: number[] | null = null;
  return list.map((c) => {
    let n = notesOf(c, octave);
    if (options.lead && before && !/\d/.test(c)) {
      // Each inversion, an octave either side: the one whose notes are nearest those before.
      const prev: number[] = before, mean = prev.reduce((a, b) => a + b, 0) / prev.length;
      let best = n, cost = Infinity;
      for (let inv = 0; inv < n.length; inv++) for (const shift of [-12, 0, 12]) {
        const cand = chordNumbers(c, octave, inv).map((x) => x + shift);
        const d = cand.length === prev.length ? cand.reduce((s, x, i) => s + Math.abs(x - prev[i]), 0) : Math.abs(cand.reduce((a, b) => a + b, 0) / cand.length - mean) * cand.length;
        if (d < cost) { cost = d; best = cand; }
      }
      n = best;
    }
    before = n;
    return over(n.map(nameOf).join("+"), template);
  });
}

/** Seconds `n` bars last at `bpm` as a song plays it (its bar a whole number of frames): how long to make a riser. */
export function bars(bpm: number, n: number = 1, beats: number = 4): number {
  return n * Math.max(1, Math.round((60 / bpm) * beats / FRAME)) * FRAME;
}

/**
 * What makes a part breathe with the beat, as a mix does under a kick: down to `1 − depth` on each beat (`beat`
 * seconds apart, from the clip's start) and back over `release` of a beat — a part's fx, or a section's:
 * `{ fx: music.pump(music.bars(143) / 4) }`.
 */
export function pump(beat: number, depth: number = 0.45, release: number = 0.55): (clip: Clip) => Clip {
  if (!(beat > 0) || !(depth >= 0 && depth <= 1) || !(release > 0 && release <= 1)) throw new Error("pump() takes seconds a beat, how deep (0 … 1) and how long it takes to come back, as a part of a beat (0 … 1).");
  return (c) => {
    const points: [number, number][] = [];
    for (let t = 0; t < c.seconds; t += beat) points.push([t, 1 - depth], [Math.min(c.seconds, t + release * beat), 1], [Math.min(c.seconds, t + beat - 0.004), 1]);
    points.push([c.seconds, 1]);
    return c.envelope(...points);
  };
}

/* ── Sounds between sections ── */

/** Noise rising for `seconds` through a filter opening, loudest at the end: what leads into a drop. */
export function riser(seconds: number, options: { readonly volume?: number; readonly rate?: number } = {}): Clip {
  const rate = options.rate ?? 44100, v = options.volume ?? 0.5, s = seconds;
  const swept = noise(s, { volume: v, rate }).filter("bandpass", [[0, 350], [s * 0.6, 1800], [s, 9000]], { resonance: 0.55 });
  const lift = tone([[0, 220], [s, 880]], s, { wave: "saw", voices: 3, detune: 25, width: 0.8, volume: v * 0.25, rate }).filter("lowpass", [[0, 500], [s, 6000]]);
  return swept.mix(lift).envelope([0, 0], [s * 0.5, 0.25], [s * 0.9, 0.85], [s, 1]).fade(0, 0.01);
}

/** A boom to land on: a falling sine under a burst of noise, ringing `seconds` (1.5). */
export function impact(options: { readonly seconds?: number; readonly volume?: number; readonly rate?: number } = {}): Clip {
  const rate = options.rate ?? 44100, v = options.volume ?? 0.8, s = options.seconds ?? 1.5;
  return tone([[0, 90], [0.4, 38], [s, 30]], s, { volume: v, rate }).envelope([0, 1], [0.15, 0.7], [s, 0])
    .mix(noise(s, { volume: v * 0.5, rate }).filter("lowpass", [[0, 6000], [s, 300]]).envelope([0, 1], [0.05, 0.4], [s, 0])).drive(3);
}

/** How a track or a part is heard. */
export interface PartOptions {
  /** Where it is heard, −1 left to 1 right; 0, the middle, when left out. */
  readonly pan?: number;
  /** How loud, 1 as the instrument plays. */
  readonly volume?: number;
  /** What it goes through: its whole part in `render`, each note on its own in `play`. */
  readonly fx?: (clip: Clip) => Clip;
  /** How much of it goes to the song's reverb in `render`, 0 … 1 (0). */
  readonly reverb?: number;
}

/** What an instrument plays, step by step. */
export interface Track {
  readonly instrument: Instrument | Kit;
  readonly steps: readonly string[];
  /** Where it is heard, −1 left to 1 right; 0, the middle, when left out. */
  readonly pan: number;
  /** How loud, 1 as the instrument plays. */
  readonly volume: number;
  /** What the track goes through: its whole part in `render`, each note on its own in `play`. */
  readonly fx?: (clip: Clip) => Clip;
  /** How much of it goes to the song's reverb in `render`, 0 … 1 (0). */
  readonly reverb: number;
}

/** A part's options checked, and its defaults filled in. */
function heard(options: PartOptions, what: string): { pan: number; volume: number; reverb: number; fx?: (clip: Clip) => Clip } {
  const pan = options.pan ?? 0, volume = options.volume ?? 1, reverb = options.reverb ?? 0;
  if (!(pan >= -1 && pan <= 1)) throw new Error(`A ${what}'s pan is −1 (left) to 1 (right), not ${pan}.`);
  if (!(volume >= 0)) throw new Error(`A ${what}'s volume is 0 or more, not ${volume}.`);
  if (!(reverb >= 0 && reverb <= 1)) throw new Error(`A ${what}'s reverb is 0 to 1, not ${reverb}.`);
  return { pan, volume, reverb, ...(options.fx ? { fx: options.fx } : {}) };
}

/**
 * A pattern for an instrument: steps a word each — a note or notes joined by +, "-" to hold, "." to rest, "|" for the
 * eye; "@" after a step's notes says how loud, "C4@0.6". `pan`: where it is heard, −1 left to 1 right (a panned track's
 * notes have two channels); `volume`: 1 as the instrument plays; `fx`: what the track goes through —
 * `(c) => c.delay(0.21).chorus()` — its whole part when the song is rendered (as a mixer's insert), each note on its own
 * when it is played note by note; `reverb`: how much goes to the song's reverb when it is rendered, 0 … 1.
 */
export function track(instrument: Instrument | Kit, pattern: Pattern, options: PartOptions = {}): Track {
  return Object.freeze({ instrument, steps: Object.freeze(wordsOf(pattern)), ...heard(options, "track") });
}

/** An instrument and how it is heard, which a song's sections give its notes: `arrange`. */
export interface Part extends Omit<Track, "steps"> { readonly kind: "part" }

/** An instrument as a part of a song made of sections (`arrange`), heard as `track` says. */
export function part(instrument: Instrument | Kit, options: PartOptions = {}): Part {
  return Object.freeze({ kind: "part" as const, instrument, ...heard(options, "part") });
}

/** How long a section lasts, as its effects need it for their points: seconds, its bars, and seconds a bar. */
export interface SectionTime { readonly seconds: number; readonly bars: number; readonly bar: number }

/** What a section is and does, besides its notes. */
export interface SectionOptions {
  /** What `song.sections` calls it. */
  readonly name?: string;
  /**
   * What a part goes through in this section only, given how long the section is — a filter opening over a build:
   * `{ pad: (c, t) => c.filter("lowpass", [[0, 400], [t.seconds, 8000]]) }`. Its notes from this section, tails and
   * all, before the part's own `fx`. Mixed by `render` only: a song with one is not played note by note.
   */
  readonly fx?: Readonly<Record<string, (clip: Clip, time: SectionTime) => Clip>>;
  /** How loud a part is in this section only, 1 as it is. */
  readonly volume?: Readonly<Record<string, number>>;
}

/** Bars of a song: what each part plays in them. */
export interface Section {
  readonly kind: "section";
  readonly name: string;
  readonly bars: number;
  readonly parts: Readonly<Record<string, Pattern>>;
  readonly fx: Readonly<Record<string, (clip: Clip, time: SectionTime) => Clip>>;
  readonly volume: Readonly<Record<string, number>>;
  /** This section with some parts written again — null: that part rests — and these options over its own. */
  with(parts: Readonly<Record<string, Pattern | null>>, options?: SectionOptions): Section;
}

/**
 * `bars` bars of a song (`arrange`), and what each part plays in them, by the part's name: `{ lead: tune, drums: beat }`.
 * A pattern shorter than the section plays again until it is filled, so a bar of drums fills eight; a part not named
 * rests. `options`: its name, a part's effects or volume for this section only.
 */
export function section(bars: number, parts: Readonly<Record<string, Pattern>>, options: SectionOptions = {}): Section {
  if (!Number.isInteger(bars) || bars < 1) throw new Error(`A section is a whole number of bars, 1 or more — not ${bars}.`);
  for (const [k, v] of Object.entries(options.volume ?? {})) if (!(v >= 0)) throw new Error(`A section's volume for ${k} is 0 or more, not ${v}.`);
  const made: Section = Object.freeze({
    kind: "section" as const, name: options.name ?? "", bars,
    parts: Object.freeze({ ...parts }), fx: Object.freeze({ ...(options.fx ?? {}) }), volume: Object.freeze({ ...(options.volume ?? {}) }),
    with(changes: Readonly<Record<string, Pattern | null>>, more: SectionOptions = {}): Section {
      const next: Record<string, Pattern> = { ...parts };
      for (const [k, p] of Object.entries(changes)) { if (p === null) delete next[k]; else next[k] = p; }
      return section(bars, next, { name: more.name ?? made.name, fx: { ...made.fx, ...(more.fx ?? {}) }, volume: { ...made.volume, ...(more.volume ?? {}) } });
    },
  });
  return made;
}

/** A song's tempo and grid. */
export interface SongOptions {
  readonly bpm: number;
  /** Steps a beat (4: sixteenths). */
  readonly steps?: number;
  /** Beats a bar (4). */
  readonly beats?: number;
  /** How late every second step starts, as a part of a step: 0 straight (as it is when left out), 1/3 a triplet's lilt. */
  readonly swing?: number;
}

/** Where a song's section is: from bar `bar` (0 the first) for `bars`, from frame `frame`. */
export interface SongSection { readonly name: string; readonly bar: number; readonly bars: number; readonly frame: number }

/** Steps of a track that belong to one section, and what that section does to them. */
interface Piece { readonly from: number; readonly to: number; readonly volume: number; readonly fx?: (clip: Clip, time: SectionTime) => Clip; readonly time: SectionTime }
const piecesOf = new WeakMap<Track, readonly Piece[]>();
/** A song of sections' parts, by name, and the track each became: what `stems` cuts. */
const partsOf = new WeakMap<Song, readonly { readonly name: string; readonly track: Track }[]>();

/**
 * A song made of sections, one after another: `parts` names each instrument and how it is heard; each section says
 * what the parts play in it. A section can be written once and played again — `arrange(o, parts, intro, verse, verse,
 * chorus)` — or played again changed: `verse.with({ lead: transpose(tune, 12) })`.
 */
export function arrange(options: SongOptions, parts: Readonly<Record<string, Part>>, ...sections: readonly Section[]): Song {
  const { perBar, barFrames } = grid(options);
  if (sections.length === 0) throw new Error("arrange() takes the song's sections, one at least.");
  const names = Object.keys(parts);
  for (const s of sections) for (const k of [...Object.keys(s.parts), ...Object.keys(s.fx), ...Object.keys(s.volume)]) {
    if (!(k in parts)) throw new Error(`A section${s.name ? ` (${s.name})` : ""} names ${JSON.stringify(k)}, which is no part of the song: its parts are ${names.join(", ")}.`);
  }
  const tracks = names.map((k) => {
    const steps: string[] = [], pieces: Piece[] = [];
    for (const s of sections) {
      const length = s.bars * perBar, from = steps.length, p = s.parts[k];
      if (p === undefined) for (let i = 0; i < length; i++) steps.push(".");
      else {
        const words = wordsOf(p);
        if (words.length === 0 || length % words.length !== 0) throw new Error(`${k}${s.name ? ` in ${s.name}` : ""}: a pattern of ${words.length} steps does not fill ${s.bars} bar${s.bars === 1 ? "" : "s"} of ${perBar} steps evenly.`);
        for (let i = 0; i < length; i++) steps.push(words[i % words.length]);
      }
      const fx = k in s.fx ? s.fx[k] : undefined, volume = s.volume[k] ?? 1;
      if (fx || volume !== 1) pieces.push({ from, to: from + length, volume, ...(fx ? { fx } : {}), time: { seconds: s.bars * barFrames * FRAME, bars: s.bars, bar: barFrames * FRAME } });
    }
    const t = track(parts[k].instrument, steps, parts[k]);
    if (pieces.length) piecesOf.set(t, pieces);
    return t;
  });
  let bar = 0;
  const placedSections = sections.map((s) => { const at = { name: s.name, bar, bars: s.bars, frame: bar * barFrames }; bar += s.bars; return Object.freeze(at); });
  const made = compose(options, tracks, placedSections);
  partsOf.set(made, names.map((k, i) => ({ name: k, track: tracks[i] })));
  return made;
}

/** A clip as a track plays it note by note: through its fx, at its volume and its pan, made once a clip a track. */
function placed(t: Track, made: Map<Clip, Clip>, c: Clip): Clip {
  if (t.pan === 0 && t.volume === 1 && !t.fx) return c;
  let p = made.get(c);
  if (!p) {
    p = t.fx ? t.fx(c) : c;
    if (t.volume !== 1) p = p.gain(t.volume);
    if (t.pan !== 0) p = p.pan(t.pan);
    made.set(c, p);
  }
  return p;
}

/** What a song's notes are, kept for render, which makes them again at its own rate; `piece`, the section whose effects it goes through. */
interface Score { readonly at: number; readonly track: Track; readonly made: Map<Clip, Clip>; readonly velocity: number; readonly piece?: Piece; readonly name?: string; readonly seconds?: number; readonly hit?: Clip }
const scores = new WeakMap<object, readonly Score[]>();

/** A song, when the script is built: the tables `play` reads, and what it takes. */
export interface Song {
  /**
   * Frames a step lasts: a bar is a whole number of frames, a step need not be (2.5 for sixteenths at 143 beats a
   * minute). Played note by note, a note starts on the frame nearest its time — within the 21 ms the game's own
   * mixer starts a sound in anyway; rendered, exactly on it.
   */
  readonly stepFrames: number;
  /** Frames a bar lasts, a whole number. */
  readonly barFrames: number;
  /** Beats a bar. */
  readonly beats: number;
  /** The tempo it plays at: the nearest to the one asked for whose bar is a whole number of frames. */
  readonly bpm: number;
  /** Steps, the longest track's. */
  readonly steps: number;
  /** Its sections, made by `arrange`, in the order they play (none for a song of tracks). */
  readonly sections: readonly SongSection[];
  /** Frames it lasts, its last note's release included. */
  readonly frames: number;
  readonly seconds: number;
  /** Each clip the song plays, once. */
  readonly clips: readonly Clip[];
  /** Each note in the order they start: the frame it starts on, from 0, and which of `clips` it is. */
  readonly at: readonly number[];
  readonly which: readonly number[];
  /** The most notes sounding at once: `play` refuses a song of more than 32 (`render` has no limit). */
  readonly voices: number;
}

/** A song's grid: steps a bar, and frames a bar and a step. */
function grid(options: SongOptions): { perBar: number; barFrames: number; stepFrames: number } {
  const perBeat = options.steps ?? 4, beats = options.beats ?? 4, swing = options.swing ?? 0;
  if (!(options.bpm > 0) || !(perBeat > 0) || !(beats > 0)) throw new Error("A song takes a tempo, { bpm: 120 }, steps a beat (4 by default) and beats a bar (4).");
  if (!(swing >= 0 && swing < 1)) throw new Error(`A song's swing is 0 (straight) to under 1 (a step late), not ${swing}.`);
  const barFrames = Math.max(1, Math.round((60 / options.bpm) * beats / FRAME));
  return { perBar: perBeat * beats, barFrames, stepFrames: barFrames / (beats * perBeat) };
}

/**
 * Tracks played together from their first step: `bpm` beats a minute, `steps` steps a beat (4 by default), `swing`
 * every second step late. Played note by note (`play`), a song is refused when more than 32 notes would sound at once;
 * rendered, it has no limit. A song of sections: `arrange`.
 */
export function song(options: SongOptions, ...tracks: readonly Track[]): Song {
  return compose(options, tracks, []);
}

function compose(options: SongOptions, tracks: readonly Track[], sections: readonly SongSection[]): Song {
  const { barFrames, stepFrames } = grid(options), beats = options.beats ?? 4, swing = options.swing ?? 0;
  const stepSeconds = stepFrames * FRAME;
  // Where step s starts, in frames: every second step `swing` of a step late.
  const time = (s: number) => (s + (s % 2 === 1 ? swing : 0)) * stepFrames;
  const score: Score[] = [];
  let steps = 0, effects = false;
  for (const t of tracks) {
    const ws = t.steps, made = new Map<Clip, Clip>(), pieces = piecesOf.get(t) ?? [];
    if (pieces.some((p) => p.fx)) effects = true;
    steps = Math.max(steps, ws.length);
    let k = 0;
    ws.forEach((w, s) => {
      while (k < pieces.length && pieces[k].to <= s) k++;
      const piece = k < pieces.length && pieces[k].from <= s ? pieces[k] : undefined;
      const { body, velocity: v } = velocityOf(w, s);
      if (body === "-" || body === ".") return;
      const velocity = v * (piece?.volume ?? 1), into = piece ? { piece } : {};
      if (t.instrument.kind === "kit") {
        for (const letter of body) {
          const hit = t.instrument.hits[letter];
          if (!hit) throw new Error(`Step ${s + 1}: the kit has no ${JSON.stringify(letter)} (it has ${Object.keys(t.instrument.hits).join(", ")}).`);
          score.push({ at: time(s), track: t, made, velocity, ...into, hit });
        }
        return;
      }
      // A note lasts its step and every "-" after it.
      let length = 1;
      while (s + length < ws.length && ws[s + length] === "-") length++;
      const seconds = swing === 0 ? length * stepSeconds : (time(s + length) - time(s)) * FRAME;
      for (const name of body.split("+")) {
        noteNumber(name);
        score.push({ at: time(s), track: t, made, velocity, ...into, name, seconds });
      }
    });
  }
  score.sort((a, b) => a.at - b.at);
  const base = (n: Score) => n.hit ?? (n.track.instrument as Instrument).note(n.name!, n.seconds!);
  // The tables `play` reads, made when they are first read: a song only rendered never makes its notes for the game.
  let table: { clips: readonly Clip[]; at: readonly number[]; which: readonly number[]; voices: number; peakStep: number; frames: number } | null = null;
  const tables = () => {
    if (table) return table;
    const notes = score.map((n) => ({ at: Math.round(n.at), clip: placed(n.track, n.made, n.velocity === 1 ? base(n) : base(n).gain(n.velocity)) }));
    // How many sound at once: at each note's start, those started before it and not yet over.
    let voices = 0, peakStep = 0;
    notes.forEach((n, k) => {
      let sounding = 0;
      for (let j = 0; j <= k; j++) if (notes[j].at + notes[j].clip.seconds / FRAME > n.at) sounding++;
      if (sounding > voices) { voices = sounding; peakStep = Math.round(n.at / stepFrames) + 1; }
    });
    const clips: Clip[] = [];
    const which = notes.map((n) => { let k = clips.indexOf(n.clip); if (k < 0) { clips.push(n.clip); k = clips.length - 1; } return k; });
    const frames = Math.max(Math.round(steps * stepFrames), ...notes.map((n) => n.at + Math.ceil(n.clip.seconds / FRAME)));
    table = { clips: Object.freeze(clips), at: Object.freeze(notes.map((n) => n.at)), which: Object.freeze(which), voices, peakStep, frames };
    return table;
  };
  // What the game plays note by note: refused, when it is read, if more than 32 would sound at once (render has no limit).
  const playable = () => {
    if (effects) throw new Error("A section of this song puts a part through effects of its own, which only music.render mixes: render the song, or give the part those effects for the whole song.");
    const t = tables();
    if (t.voices > VOICES) throw new Error(`At step ${t.peakStep}, ${t.voices} notes would sound at once; the game plays ${VOICES} note by note. Shorten notes or thin the chords — or music.render the song, one sound however many it mixes.`);
    return t;
  };
  const made: Song = Object.freeze({
    stepFrames, barFrames, beats, bpm: (60 * beats) / (barFrames * FRAME), steps, sections: Object.freeze([...sections]),
    get frames() { return tables().frames; },
    get seconds() { return tables().frames * FRAME; },
    get clips() { return playable().clips; },
    get at() { return playable().at; },
    get which() { return playable().which; },
    get voices() { return tables().voices; },
  });
  scores.set(made, score);
  return made;
}

/** The General MIDI drums, by number, as `drums()` has them: kicks k, snares s, the clap c, hats h and o, toms t, the rim r, crashes x. */
const GM_DRUMS: Readonly<Record<number, string>> = {
  35: "k", 36: "k", 37: "r", 38: "s", 40: "s", 39: "c", 42: "h", 44: "h", 51: "h", 53: "h", 59: "h", 46: "o",
  41: "t", 43: "t", 45: "t", 47: "t", 48: "t", 50: "t", 49: "x", 52: "x", 55: "x", 57: "x",
};

/** How imported notes are made a song: its grid, and which kit letter a drum's number plays. */
export interface MidiOptions extends Omit<SongOptions, "bpm"> {
  /** Beats a minute: the file's own when left out. */
  readonly bpm?: number;
  /** A drum's MIDI number to a kit's letter, over General MIDI's (36 "k", 38 "s", 42 "h", 46 "o", 49 "x", …). */
  readonly drums?: Readonly<Record<number, string>>;
}

/**
 * A song of imported notes (`import tune from "./tune.notes"`): each track `parts` names — by its name, or its place
 * in `tune.tracks` from 0 — played by an instrument, a kit (the drums by their General MIDI numbers) or a `part`;
 * the tracks not named are left out. Each note starts on the step nearest its time and lasts the steps nearest its
 * length (`steps` a beat, 4: sixteenths); how hard it was struck is how loud it plays, 100 as written. A track whose
 * notes overlap becomes several, so the song can hold them. At the file's first tempo unless `bpm` says.
 */
export function midi(notes: Notes, parts: Readonly<Record<string, Instrument | Kit | Part>>, options: MidiOptions = {}): Song {
  const perBeat = options.steps ?? 4, map = { ...GM_DRUMS, ...(options.drums ?? {}) };
  const names = notes.tracks.map((t) => t.name);
  const tracks: Track[] = [];
  for (const [key, given] of Object.entries(parts)) {
    const index = names.indexOf(key) >= 0 ? names.indexOf(key) : /^\d+$/.test(key) ? Number(key) : -1;
    const source = notes.tracks[index];
    if (!source) throw new Error(`The notes have no track ${JSON.stringify(key)}: their tracks are ${names.map((n) => JSON.stringify(n)).join(", ")} (or 0 to ${names.length - 1}).`);
    const instrument = given.kind === "part" ? given.instrument : given, how = given.kind === "part" ? given : {};
    const kit = instrument.kind === "kit" ? instrument : null;
    // Voices: steps that each hold one chord at a time; a note joins a chord struck with it, or the first voice free.
    type Word = { sounds: string[]; velocity: number; length: number };
    const voices: { words: Map<number, Word>; end: number; last: number }[] = [];
    const placed = source.notes.map((n) => {
      const from = Math.round(n.at * perBeat);
      return { from, length: kit ? 1 : Math.max(1, Math.round((n.at + n.beats) * perBeat) - from), sound: kit ? map[n.pitch] : nameOf(n.pitch), velocity: Math.max(0.05, Math.round((n.velocity / 100) * 20) / 20) };
    }).filter((n) => n.sound !== undefined && (!kit || n.sound in kit.hits)).sort((a, b) => a.from - b.from || b.length - a.length);
    for (const n of placed) {
      let voice = voices.find((v) => { const w = v.words.get(v.last); return v.last === n.from && w !== undefined && w.length === n.length && w.velocity === n.velocity; });
      if (voice) { const w = voice.words.get(n.from)!; if (!w.sounds.includes(n.sound)) w.sounds.push(n.sound); continue; }
      voice = voices.find((v) => v.end <= n.from);
      if (!voice) { voice = { words: new Map(), end: 0, last: -1 }; voices.push(voice); }
      voice.words.set(n.from, { sounds: [n.sound], velocity: n.velocity, length: n.length });
      voice.end = n.from + n.length;
      voice.last = n.from;
    }
    for (const v of voices) {
      const steps: string[] = Array.from({ length: v.end }, () => ".");
      for (const [at, w] of v.words) {
        steps[at] = (kit ? w.sounds.join("") : w.sounds.join("+")) + (w.velocity === 1 ? "" : `@${w.velocity}`);
        if (!kit) for (let k = 1; k < w.length; k++) steps[at + k] = "-";
      }
      tracks.push(track(instrument, steps, how));
    }
  }
  return compose({ ...options, bpm: options.bpm ?? notes.bpm, beats: options.beats ?? notes.beats }, tracks, []);
}

/** The song's reverb in `render`, as `Clip.reverb` takes it, the dry part left out. */
export interface ReverbOptions { readonly decay?: number; readonly damping?: number; readonly predelay?: number; readonly width?: number }

/**
 * A song mixed into one clip when the script is built: every note exactly in time, one sound playing. Mixed as a
 * mixing desk does: each track's notes made again at `rate` (44 100 when left out: what the ear hears up to 20 kHz; a
 * note played in the game note by note is made at 22 050, to keep the map small) into its own part, through a
 * section's effects where it has them, then its `fx`, at its volume, to its side; what each track sends (its `reverb`)
 * into one reverb shared by them all (`reverb`, its room); the whole through `master` —
 * `(mix) => mix.compress({ threshold: -14, ratio: 2 })` — and last a limiter (`Clip.limit`) so it never goes over
 * −1.5 dB however the parts add, between the samples too: `limit: false` leaves it as mixed, `{ ceiling, release }` sets it. A long clip a
 * program plays goes in the map as Ogg Vorbis, two channels when it has two.
 */
export function render(s: Song, options: { readonly rate?: number; readonly limit?: boolean | { readonly ceiling?: number; readonly release?: number }; readonly reverb?: ReverbOptions; readonly master?: (mix: Clip) => Clip } = {}): Clip {
  const rate = options.rate ?? 44100, score = scores.get(s), least = s.steps * s.stepFrames * FRAME;
  let mixed: Clip;
  if (!score) {
    // (A song from elsewhere, without its score: its own clips, at their rate.)
    mixed = mixdown(s.at.map((at, k) => ({ clip: s.clips[s.which[k]], at: at * FRAME })), s.seconds, rate);
  } else {
    const parts: { clip: Clip; at: number }[] = [], sends: { clip: Clip; at: number }[] = [];
    const byTrack = new Map<Track, Score[]>();
    for (const n of score) { const list = byTrack.get(n.track); if (list) list.push(n); else byTrack.set(n.track, [n]); }
    for (const [t, notes] of byTrack) {
      const clipOf = (n: Score) => { const c = n.hit ?? (t.instrument as Instrument).note(n.name!, n.seconds!, rate); return n.velocity === 1 ? c : c.gain(n.velocity); };
      // The notes as they are, and each section's that has effects of its own mixed apart and through them.
      const entries: { clip: Clip; at: number }[] = [], apart = new Map<Piece, Score[]>();
      for (const n of notes) {
        if (n.piece?.fx) { const list = apart.get(n.piece); if (list) list.push(n); else apart.set(n.piece, [n]); }
        else entries.push({ clip: clipOf(n), at: n.at * FRAME });
      }
      for (const [p, list] of apart) {
        const from = p.from * s.stepFrames;
        const sub = mixdown(list.map((n) => ({ clip: clipOf(n), at: (n.at - from) * FRAME })), p.time.seconds, rate);
        entries.push({ clip: p.fx!(sub, p.time), at: from * FRAME });
      }
      let part = mixdown(entries, least, rate);
      if (t.fx) part = t.fx(part);
      if (t.volume !== 1) part = part.gain(t.volume);
      if (t.pan !== 0) part = part.pan(t.pan);
      parts.push({ clip: part, at: 0 });
      if (t.reverb > 0) sends.push({ clip: part.gain(t.reverb), at: 0 });
    }
    if (sends.length) {
      const r = options.reverb ?? {};
      parts.push({ clip: mixdown(sends, least, rate).reverb({ decay: r.decay ?? 0.7, damping: r.damping ?? 0.45, predelay: r.predelay ?? 0.02, width: r.width ?? 1, mix: 1, dry: 0 }), at: 0 });
    }
    mixed = mixdown(parts, least, rate);
  }
  if (options.master) mixed = options.master(mixed);
  const limit = options.limit ?? true;
  return limit === false ? mixed : mixed.limit(limit === true ? {} : limit);
}

/* ── Music that follows the game: a song cut into pieces, played piece by piece ── */

/** How a song of sections is cut for the game to play piece by piece (`stems`). */
export interface StemsOptions {
  /**
   * Which parts each layer holds, by name — `{ drums: ["kit", "hats"], bass: ["bass"], melody: ["lead", "saw"] }` — a
   * layer the game can turn on and off where a piece begins. A part in no layer is left out.
   */
  readonly layers: Readonly<Record<string, readonly string[]>>;
  /**
   * Beats a piece: where the game can go to another section or turn a layer on or off (a bar's beats when left out).
   * Two in a bar of four halves the wait for a change, for about half as much map again and more sounds at once.
   */
  readonly every?: number;
  /** Samples a second (44 100). */
  readonly rate?: number;
  /** The reverb's room, as `render` takes it. */
  readonly reverb?: ReverbOptions;
  /** What each piece's clip goes through last — an EQ, not a compressor: each is on its own, the game adds them up. */
  readonly master?: (clip: Clip) => Clip;
  /** The loudest the pieces may add up to as the song plays through, every layer on (0.84, −1.5 dB). */
  readonly peak?: number;
  /**
   * Seconds a piece's clip rings on after its notes end (2), its echoes and reverb faded out over the last of them: the
   * pieces after it cover the rest, and a shorter clip is a smaller map. A layer's last piece keeps all of its tail.
   */
  readonly tail?: number;
  /** The Ogg Vorbis quality of the pieces' clips (4: a little smaller than a song's 5, as many play at once). */
  readonly quality?: number;
  /**
   * Sounds to play on the next beat when the game asks (`band.sting`): a crash for a cleared line, a hit for a boss.
   * Turned down with the pieces, which leave room for one on any beat.
   */
  readonly stingers?: Readonly<Record<string, Clip>>;
}

/** A song cut into pieces for the game to play piece by piece, with `conduct` and a `Band`: made when the script is built. */
export interface Stems {
  readonly kind: "stems";
  /** Frames a bar lasts. */
  readonly barFrames: number;
  readonly bpm: number;
  /** Beats a bar, and beats a piece. */
  readonly beats: number;
  readonly every: number;
  /** Frames each beat of a piece lasts, whole frames (beats of a bar not a whole number of frames take turns). */
  readonly waits: readonly number[];
  /** The layers' names, in the order `band.on` has them. */
  readonly layers: readonly string[];
  /** The sections, in the order the song plays them: their names and how many bars. */
  readonly sections: readonly SongSection[];
  /**
   * Section `s`'s piece `p` in layer `l`: its notes, their tails and echoes and reverb with them, or null where it plays
   * none. A section of `bars` bars has bars × beats / every pieces.
   */
  readonly pieces: readonly (readonly (readonly (Clip | null)[])[])[];
  readonly stingers: readonly Clip[];
  /** A section's place in `sections`, by its name: `band.go(stems.section("drop"))`. */
  section(name: string): number;
  /** A layer's place in `layers`, by its name: `band.mute(stems.layer("drums"))`. */
  layer(name: string): number;
  /** A stinger's place, by its name: `band.sting(stems.stinger("crash"))`. */
  stinger(name: string): number;
  /** The most clips sounding at once as the song plays through, every layer on: of the game's 32, what is left for the rest. */
  readonly voices: number;
}

/**
 * A song of sections (`arrange`) cut into pieces — a bar each, or `every` beats — a clip each piece of each layer, for
 * music that follows the game: where each piece begins the program says which section plays and which layers (`Band`,
 * `conduct`), and a stinger plays on the next beat. A piece's clip holds the notes that start in it, with their tails,
 * echoes and reverb, so it overlaps the next and nothing is cut off, whichever comes after it; a piece the same as
 * another is the same clip, one file in the map. Each layer is mixed as `render` mixes the song, but with no master
 * and no limiter between the parts — the game adds the clips up — so all of them are turned down together until the
 * song played through stays under `peak`.
 */
export function stems(s: Song, options: StemsOptions): Stems {
  const parts = partsOf.get(s), score = scores.get(s);
  if (!parts || !score) throw new Error("stems() cuts a song made of sections, by music.arrange.");
  const rate = options.rate ?? 44100, layers = Object.keys(options.layers), r = options.reverb ?? {}, tail = options.tail ?? 2;
  if (!(tail > 0)) throw new Error(`stems()' tail is seconds after a piece, more than 0, not ${tail}.`);
  if (layers.length === 0 || layers.length > 8) throw new Error(`stems() takes one to eight layers, not ${layers.length}.`);
  const beats = s.beats, every = options.every ?? beats, piece = (s.barFrames * every) / beats;
  if (!Number.isInteger(every) || every < 1 || every > beats || beats % every !== 0) throw new Error(`stems() cuts every few beats of a bar's ${beats}, a number that divides it — not every ${every}.`);
  if (!Number.isInteger(piece)) throw new Error(`A piece of ${every} beats would be ${piece.toFixed(2)} frames: the game plays a sound on a frame. Make it a bar (every: ${beats}), or a tempo whose bar divides into whole frames.`);
  const perBar = beats / every;
  const layerOf = new Map<Track, number>();
  layers.forEach((name, l) => {
    for (const p of options.layers[name]) {
      const found = parts.find((x) => x.name === p);
      if (!found) throw new Error(`The layer ${name} names ${JSON.stringify(p)}, which is no part of the song: its parts are ${parts.map((x) => x.name).join(", ")}.`);
      if (layerOf.has(found.track)) throw new Error(`${p} is in two layers: a part is in one at most.`);
      layerOf.set(found.track, l);
    }
  });
  const pieceSeconds = piece * FRAME, total = s.sections.reduce((n, x) => n + x.bars, 0) * perBar;
  // The notes of each piece of each layer, by part.
  const cells: Map<Track, Score[]>[][] = Array.from({ length: total }, () => layers.map(() => new Map()));
  for (const n of score) {
    const l = layerOf.get(n.track);
    if (l === undefined) continue;
    const g = Math.min(total - 1, Math.floor((n.at + 1e-6) / piece));
    const m = cells[g][l], list = m.get(n.track);
    if (list) list.push(n); else m.set(n.track, [n]);
  }
  const clipOf = (t: Track, n: Score) => { const c = n.hit ?? (t.instrument as Instrument).note(n.name!, n.seconds!, rate); return n.velocity === 1 ? c : c.gain(n.velocity); };
  // Each layer's last piece with notes: it rings out whole, as the song ends.
  const last = layers.map((_, l) => { let g = total - 1; while (g > 0 && cells[g][l].size === 0) g--; return g; });
  // A piece of a layer, mixed: each part's notes from where it begins, through what the part goes through, and the reverb.
  const raw: (Clip | null)[][] = cells.map((byLayer, g) => byLayer.map((m, l) => {
    const out: { clip: Clip; at: number }[] = [], sends: { clip: Clip; at: number }[] = [];
    // Where the piece's last note ends, its release and all: a riser four bars long is kept whole.
    let end = pieceSeconds;
    for (const [t, notes] of m) for (const n of notes) end = Math.max(end, (n.at - g * piece) * FRAME + clipOf(t, n).seconds);
    for (const [t, notes] of m) {
      const plain = notes.filter((n) => !n.piece?.fx), apart = notes.filter((n) => n.piece?.fx);
      const entries: { clip: Clip; at: number }[] = plain.map((n) => ({ clip: clipOf(t, n), at: (n.at - g * piece) * FRAME }));
      if (apart.length) {
        // A section's effects take the whole section: this piece's notes where they fall in it, then the piece cut out.
        const p = apart[0].piece!, from = p.from * s.stepFrames, into = (g * piece - from) * FRAME;
        const whole = p.fx!(mixdown(apart.map((n) => ({ clip: clipOf(t, n), at: (n.at - from) * FRAME })), undefined, rate), p.time);
        entries.push({ clip: whole.trim(into, whole.seconds), at: 0 });
      }
      let part = mixdown(entries, undefined, rate);
      if (t.fx) part = t.fx(part);
      if (t.volume !== 1) part = part.gain(t.volume);
      if (t.pan !== 0) part = part.pan(t.pan);
      out.push({ clip: part, at: 0 });
      if (t.reverb > 0) sends.push({ clip: part.gain(t.reverb), at: 0 });
    }
    if (out.length === 0) return null;
    if (sends.length) out.push({ clip: mixdown(sends, undefined, rate).reverb({ decay: r.decay ?? 0.7, damping: r.damping ?? 0.45, predelay: r.predelay ?? 0.02, width: r.width ?? 1, mix: 1, dry: 0 }), at: 0 });
    let mixed = mixdown(out, undefined, rate);
    if (options.master) mixed = options.master(mixed);
    // What rings on after the piece's notes, kept for `tail` seconds and faded over the last of them — the pieces
    // after cover the rest — but all of it after the layer's last piece.
    const keep = end + tail;
    return g < last[l] && mixed.seconds > keep ? mixed.trim(0, keep).fade(0, Math.min(1, tail / 2)) : mixed;
  }));
  // All of them turned down together, as the song plays through.
  const placed: { clip: Clip; at: number; g: number; l: number }[] = [];
  raw.forEach((byLayer, g) => byLayer.forEach((c, l) => { if (c) placed.push({ clip: c, at: g * pieceSeconds, g, l }); }));
  if (placed.length === 0) throw new Error("stems(): the layers play no notes.");
  // The stingers may play on any beat: turned down with the pieces, and room left for them over the loudest.
  const waits = Array.from({ length: every }, (_, j) => Math.round(((j + 1) * piece) / every) - Math.round((j * piece) / every));
  const stingerNames = Object.keys(options.stingers ?? {});
  const lines: number[] = [];
  for (let g = 0; g < total; g++) { let at = g * piece; for (const w of waits) { lines.push(at * FRAME); at += w; } }
  const fitted = together(placed, { peak: options.peak ?? 0.84, over: stingerNames.map((k) => ({ clip: options.stingers![k], at: lines })) });
  const grid: (Clip | null)[][] = raw.map((byLayer) => byLayer.map(() => null));
  const quality = options.quality ?? 4;
  placed.forEach((p, k) => { grid[p.g][p.l] = fitted[k].ogg(quality); });
  const stingers = stingerNames.map((_, k) => fitted[placed.length + k]);
  let start = 0;
  const pieces = s.sections.map((sec) => { const n = sec.bars * perBar, rows = grid.slice(start, start + n).map((row) => Object.freeze(row)); start += n; return Object.freeze(rows); });
  const lookup = (what: string, list: readonly string[], name: string) => {
    const k = list.indexOf(name);
    if (k < 0) throw new Error(`There is no ${what} ${JSON.stringify(name)}: there are ${list.map((x) => JSON.stringify(x)).join(", ") || "none"}.`);
    return k;
  };
  let voices = -1;
  return Object.freeze({
    kind: "stems" as const, barFrames: s.barFrames, bpm: s.bpm, beats, every, waits: Object.freeze(waits),
    layers: Object.freeze(layers), sections: s.sections, pieces: Object.freeze(pieces), stingers: Object.freeze(stingers),
    section: (name: string) => lookup("section", s.sections.map((x) => x.name), name),
    layer: (name: string) => lookup("layer", layers, name),
    stinger: (name: string) => lookup("stinger", stingerNames, name),
    get voices() {
      if (voices < 0) {
        voices = 0;
        for (const p of placed) { let n = 0; for (const q of placed) if (q.at <= p.at && q.at + q.clip.seconds > p.at) n++; voices = Math.max(voices, n); }
      }
      return voices;
    },
  });
}

/**
 * The music as the game steers it: which section plays, which piece of it, which layers. Make one inside the program
 * that steers the music and hand it to `conduct`, which plays a piece where each begins as it says:
 *
 *   import { music, Band } from "trigscript/music";
 *   const band = new Band();
 *   start(music.conduct(stems, band));
 *   band.go(stems.section("drop"));        // where the next piece begins
 *   band.mute(stems.layer("drums"));
 *   band.sting(stems.stinger("crash"));    // on the next beat
 *
 * With nothing said, the song plays through its sections in order and starts again.
 */
export class Band {
  /** The section playing, its place in `stems.sections`; the piece of it (a bar, unless `stems.every` says), from 0; the beat of the piece. */
  section = 0;
  piece = 0;
  beat = 0;
  /** Pieces played since it started. */
  count = 0;
  /** The game's frame the beat playing began on: how far into the beat it is, for what moves with the music. */
  at = 0;
  /** The section to go to, and whether where the next piece begins (`go`) or when this section ends (`queue`); −1 for none. */
  next = -1;
  now = false;
  /** Whether a section plays again when it ends, instead of going on to the next. */
  loop = false;
  /** Which layers play, by their place in `stems.layers`. */
  on = [true, true, true, true, true, true, true, true];
  /** A stinger to play on the next beat, by its place; −1 for none. */
  stung = -1;
  /** Whether it plays: false stops it where the next piece would begin (what sounds rings out). */
  playing = true;

  /** Go to a section where the next piece begins, from its first piece. */
  go(section: number) {
    this.next = section;
    this.now = true;
  }
  /** Go to a section when the one playing ends. */
  queue(section: number) {
    this.next = section;
    this.now = false;
  }
  /** Turn a layer off, or on, from where the next piece begins. */
  mute(layer: number) {
    this.on[layer] = false;
  }
  unmute(layer: number) {
    this.on[layer] = true;
  }
  /** Play a stinger on the next beat. */
  sting(stinger: number) {
    this.stung = stinger;
  }
  /** Stop where the next piece would begin. */
  stop() {
    this.playing = false;
  }
}

/** Play `stems` as `band` says, beat by beat, until it stops: `start(music.conduct(stems, band))` beside the program. */
export const conduct = game(async (s: Stems, band: Band) => {
  band.playing = true;
  band.beat = 0;
  while (band.playing || band.beat > 0) {
    band.at = memory.game.frame;
    if (band.beat === 0) {
      // Where a piece begins: where to be, then the piece's clip of each layer that is on. (Which clip, by test: a
      // clip is no value a program holds.)
      if (band.next >= 0 && (band.now || band.piece === 0)) {
        band.section = band.next;
        band.piece = 0;
        band.next = -1;
      }
      for (let k = 0; k < s.sections.length; k++) if (band.section === k) {
        for (let p = 0; p < s.pieces[k].length; p++) if (band.piece === p) {
          for (let l = 0; l < s.layers.length; l++) if (s.pieces[k][p][l]) if (band.on[l]) playWav(s.pieces[k][p][l]!, 0);
        }
      }
    }
    for (let j = 0; j < s.stingers.length; j++) if (band.stung === j) playWav(s.stingers[j], 0);
    band.stung = -1;
    for (let j = 0; j < s.every; j++) if (band.beat === j) await sleep(frames(s.waits[j]));
    band.beat++;
    if (band.beat >= s.every) {
      band.beat = 0;
      band.count++;
      band.piece++;
      // A section ended: again, or on to the next (after the last, the first).
      for (let k = 0; k < s.sections.length; k++) if (band.section === k) if (band.piece >= s.pieces[k].length) {
        band.piece = 0;
        if (!band.loop) band.section = k + 1 < s.sections.length ? k + 1 : 0;
      }
      if (!band.playing) band.beat = 0;
    }
  }
});

/**
 * Play a song, note by note, inside an async program: \`await music.play(song)\` resolves at its end, or
 * \`start(music.play(song))\` plays it beside the program.
 */
export const play = game(async (s: Song) => {
  const at = s.at;
  const which = s.which;
  let i = 0;
  let now = 0;
  while (i < at.length) {
    if (at[i] > now) {
      await sleep(frames(at[i] - now));
      now = at[i];
    }
    const k = which[i];
    // Which clip, by its number: a test a clip (a loop over a length known when the script is built is unrolled, and
    // the clips stay the song's, known when it is built — a clip is no value a program holds).
    for (let j = 0; j < s.clips.length; j++) if (k === j) playWav(s.clips[j], 0);
    i++;
  }
  if (s.frames > now) await sleep(frames(s.frames - now));
});

/** Play a song again and again; start it beside a program: \`start(music.loop(song))\`. */
export const loop = game(async (s: Song) => {
  while (true) await play(s);
});

/** Everything above as one name: import { music } from "trigscript/music"; music.play(song). */
export const music = {
  sampler, synth, fmSynth, strings, presets, drums, kit, track, song, render, play, loop,
  part, section, arrange, transpose, stretch, repeat, beat, chord, over, chords, bars, pump, riser, impact, midi, stems, conduct,
};
