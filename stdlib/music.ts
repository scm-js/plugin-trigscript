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
 * eye. A kit's step is its sounds' letters ("kh": kick and hat). Everything is worked out when the script is built: each
 * note an instrument plays becomes a clip once (`trigscript`'s Clip, put in the map once however often it plays), and
 * the song a table of which clip starts on which frame, which `play` reads while the game runs.
 *
 * What the game does with it (the sound probe, 2026-10-19): a step is a whole number of frames (42 ms on Fastest), so
 * the tempo is the nearest that fits — `song.bpm` says which; a sound starts within 21 ms of its frame; 32 sound at
 * once, and a song that would need more is refused; notes that overlap add, with no limiter, so keep the volumes down.
 * `render` mixes a song into one clip when the script is built instead: every note exactly in time, one sound playing,
 * nothing to change while it plays. A program plays to its own player; a program for each player plays to each.
 */
import { game, sleep, frames, playWav, tone, noise, fm, pluck, mixdown, type Clip } from "trigscript";

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
function midi(name: string): number {
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
  const base = midi(root), release = options.release ?? 0.05, volume = options.volume ?? 1;
  return Object.freeze({
    kind: "notes" as const,
    note: remembering((name, seconds) => {
      const pitched = clip.pitch(midi(name) - base).gain(volume);
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
      const pitch = options.glide ? [[0, 440 * 2 ** ((midi(name) + options.glide - 69) / 12)], [options.glideTime ?? 0.06, name]] as [number, number | string][] : name;
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
 * A drum kit made from nothing, a letter a drum: k kick, s snare, c clap, h closed hat, o open hat, t tom, r rim. At
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
  return kit({ k: kick.gain(v), s: snare.gain(v), c: clap.gain(v), h: hat(0.07).gain(0.55 * v), o: hat(0.4).gain(0.5 * v), t: tom.gain(v), r: rim.gain(v) });
}

/** A kit: a clip a letter, played by a pattern's letters ("kh" plays k and h together). */
export function kit(hits: Readonly<Record<string, Clip>>): Kit {
  for (const k of Object.keys(hits)) if (k.length !== 1 || k === "." || k === "-" || k === "|") throw new Error(`A kit's sounds are named by one letter each, not ${JSON.stringify(k)}.`);
  return Object.freeze({ kind: "kit" as const, hits: Object.freeze({ ...hits }) });
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

/**
 * A pattern for an instrument: steps a word each — a note or notes joined by +, "-" to hold, "." to rest, "|" for the
 * eye. `pan`: where it is heard, −1 left to 1 right (a panned track's notes have two channels); `volume`: 1 as the
 * instrument plays; `fx`: what the track goes through — `(c) => c.delay(0.21).chorus()` — its whole part when the song
 * is rendered (as a mixer's insert), each note on its own when it is played note by note; `reverb`: how much goes to
 * the song's reverb when it is rendered, 0 … 1.
 */
export function track(instrument: Instrument | Kit, pattern: string | readonly string[], options: { readonly pan?: number; readonly volume?: number; readonly fx?: (clip: Clip) => Clip; readonly reverb?: number } = {}): Track {
  const text = typeof pattern === "string" ? pattern : pattern.join(" ");
  const pan = options.pan ?? 0, volume = options.volume ?? 1, reverb = options.reverb ?? 0;
  if (!(pan >= -1 && pan <= 1)) throw new Error(`A track's pan is −1 (left) to 1 (right), not ${pan}.`);
  if (!(volume >= 0)) throw new Error(`A track's volume is 0 or more, not ${volume}.`);
  if (!(reverb >= 0 && reverb <= 1)) throw new Error(`A track's reverb is 0 to 1, not ${reverb}.`);
  return Object.freeze({ instrument, steps: Object.freeze(text.split(/\s+/).filter((w) => w !== "" && w !== "|")), pan, volume, reverb, ...(options.fx ? { fx: options.fx } : {}) });
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

/** What a song's notes are, kept for render, which makes them again at its own rate. */
interface Score { readonly at: number; readonly track: Track; readonly made: Map<Clip, Clip>; readonly name?: string; readonly seconds?: number; readonly hit?: Clip }
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
  /** The tempo it plays at: the nearest to the one asked for whose bar is a whole number of frames. */
  readonly bpm: number;
  /** Steps, the longest track's. */
  readonly steps: number;
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

/**
 * Tracks played together from their first step: `bpm` beats a minute, `steps` steps a beat (4 by default). Played
 * note by note (`play`), a song is refused when more than 32 notes would sound at once; rendered, it has no limit.
 */
export function song(options: { readonly bpm: number; readonly steps?: number; readonly beats?: number }, ...tracks: readonly Track[]): Song {
  const perBeat = options.steps ?? 4, beats = options.beats ?? 4;
  if (!(options.bpm > 0) || !(perBeat > 0) || !(beats > 0)) throw new Error("song() takes a tempo, { bpm: 120 }, steps a beat (4 by default) and beats a bar (4).");
  const barFrames = Math.max(1, Math.round((60 / options.bpm) * beats / FRAME));
  const stepFrames = barFrames / (beats * perBeat);
  const stepSeconds = stepFrames * FRAME;
  const score: Score[] = [];
  let steps = 0;
  for (const t of tracks) {
    const ws = t.steps, made = new Map<Clip, Clip>();
    steps = Math.max(steps, ws.length);
    ws.forEach((w, s) => {
      if (w === "-" || w === ".") return;
      if (t.instrument.kind === "kit") {
        for (const letter of w) {
          const hit = t.instrument.hits[letter];
          if (!hit) throw new Error(`Step ${s + 1}: the kit has no ${JSON.stringify(letter)} (it has ${Object.keys(t.instrument.hits).join(", ")}).`);
          score.push({ at: s * stepFrames, track: t, made, hit });
        }
        return;
      }
      // A note lasts its step and every "-" after it.
      let length = 1;
      while (s + length < ws.length && ws[s + length] === "-") length++;
      for (const name of w.split("+")) {
        midi(name);
        score.push({ at: s * stepFrames, track: t, made, name, seconds: length * stepSeconds });
      }
    });
  }
  score.sort((a, b) => a.at - b.at);
  // The tables `play` reads, made when they are first read: a song only rendered never makes its notes for the game.
  let table: { clips: readonly Clip[]; at: readonly number[]; which: readonly number[]; voices: number; peakStep: number; frames: number } | null = null;
  const tables = () => {
    if (table) return table;
    const notes = score.map((n) => ({ at: Math.round(n.at), clip: placed(n.track, n.made, n.hit ?? (n.track.instrument as Instrument).note(n.name!, n.seconds!)) }));
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
    const t = tables();
    if (t.voices > VOICES) throw new Error(`At step ${t.peakStep}, ${t.voices} notes would sound at once; the game plays ${VOICES} note by note. Shorten notes or thin the chords — or music.render the song, one sound however many it mixes.`);
    return t;
  };
  const made: Song = Object.freeze({
    stepFrames, barFrames, bpm: (60 * beats) / (barFrames * FRAME), steps,
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

/** The song's reverb in `render`, as `Clip.reverb` takes it, the dry part left out. */
export interface ReverbOptions { readonly decay?: number; readonly damping?: number; readonly predelay?: number; readonly width?: number }

/**
 * A song mixed into one clip when the script is built: every note exactly in time, one sound playing. Mixed as a
 * mixing desk does: each track's notes made again at `rate` (44 100 when left out: what the ear hears up to 20 kHz; a
 * note played in the game note by note is made at 22 050, to keep the map small) into its own part, through its `fx`,
 * at its volume, to its side; what each track sends (its `reverb`) into one reverb shared by them all (`reverb`, its
 * room); the whole through `master` — `(mix) => mix.compress({ threshold: -14, ratio: 2 })` — and last a limiter
 * (`Clip.limit`) so it never goes over −1.5 dB however the parts add: `limit: false` leaves it as mixed,
 * `{ ceiling, release }` sets it. A long clip a program plays goes in the map as Ogg Vorbis, two channels when it has two.
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
      let part = mixdown(notes.map((n) => ({ clip: n.hit ?? (t.instrument as Instrument).note(n.name!, n.seconds!, rate), at: n.at * FRAME })), least, rate);
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
export const music = { sampler, synth, fmSynth, strings, presets, drums, kit, track, song, render, play, loop };
