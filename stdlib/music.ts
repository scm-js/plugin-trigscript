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
import { game, sleep, frames, playWav, tone, mixdown, type Clip } from "trigscript";

/** Seconds a frame lasts on Fastest, the speed a map is played at. */
const FRAME = 0.042;
/** Sounds the game plays at once. */
const VOICES = 32;

/** What plays a pattern's notes: each note a clip, made when the script is built. */
export interface Instrument {
  readonly kind: "notes";
  /** Note `name` ("C4", "F#5") lasting `seconds`, release and all: a clip to play on its own, too. */
  note(name: string, seconds: number): Clip;
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
function remembering(make: (name: string, seconds: number) => Clip): (name: string, seconds: number) => Clip {
  const made = new Map<string, Clip>();
  return (name, seconds) => {
    const key = `${name} ${seconds.toFixed(4)}`;
    let c = made.get(key);
    if (!c) { c = make(name, seconds); made.set(key, c); }
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

/**
 * An instrument made of tones: `wave` ("sine", "square", "triangle", "saw") shaped by an attack, a decay to the
 * sustain level, and a release after the note's length.
 */
export function synth(options: { readonly wave?: "sine" | "square" | "triangle" | "saw"; readonly volume?: number; readonly attack?: number; readonly decay?: number; readonly sustain?: number; readonly release?: number } = {}): Instrument {
  const wave = options.wave ?? "square", volume = options.volume ?? 0.2;
  const attack = options.attack ?? 0.005, decay = options.decay ?? 0.08, sustain = options.sustain ?? 0.7, release = options.release ?? 0.06;
  return Object.freeze({
    kind: "notes" as const,
    note: remembering((name, seconds) => {
      const held = Math.max(attack + decay, seconds - release);
      return tone(name, held + release, { wave, volume }).envelope([0, 0], [attack, 1], [attack + decay, sustain], [held, sustain], [held + release, 0]);
    }),
  });
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
}

/** A pattern for an instrument: steps a word each — a note or notes joined by +, "-" to hold, "." to rest, "|" for the eye. */
export function track(instrument: Instrument | Kit, pattern: string | readonly string[]): Track {
  const text = typeof pattern === "string" ? pattern : pattern.join(" ");
  return Object.freeze({ instrument, steps: Object.freeze(text.split(/\s+/).filter((w) => w !== "" && w !== "|")) });
}

/** A song, when the script is built: the tables `play` reads, and what it takes. */
export interface Song {
  /** Frames a step lasts. */
  readonly stepFrames: number;
  /** The tempo it plays at: the nearest to the one asked for whose step is a whole number of frames. */
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
  /** The most notes sounding at once. */
  readonly voices: number;
}

/**
 * Tracks played together from their first step: `bpm` beats a minute, `steps` steps a beat (4 by default). Refused
 * when more than 32 notes would sound at once.
 */
export function song(options: { readonly bpm: number; readonly steps?: number }, ...tracks: readonly Track[]): Song {
  const perBeat = options.steps ?? 4;
  if (!(options.bpm > 0) || !(perBeat > 0)) throw new Error("song() takes a tempo, { bpm: 120 }, and steps a beat (4 by default).");
  const stepFrames = Math.max(1, Math.round(60 / options.bpm / perBeat / FRAME));
  const stepSeconds = stepFrames * FRAME;
  const notes: { at: number; clip: Clip }[] = [];
  let steps = 0;
  for (const t of tracks) {
    const ws = t.steps;
    steps = Math.max(steps, ws.length);
    ws.forEach((w, s) => {
      if (w === "-" || w === ".") return;
      if (t.instrument.kind === "kit") {
        for (const letter of w) {
          const hit = t.instrument.hits[letter];
          if (!hit) throw new Error(`Step ${s + 1}: the kit has no ${JSON.stringify(letter)} (it has ${Object.keys(t.instrument.hits).join(", ")}).`);
          notes.push({ at: s * stepFrames, clip: hit });
        }
        return;
      }
      // A note lasts its step and every "-" after it.
      let length = 1;
      while (s + length < ws.length && ws[s + length] === "-") length++;
      for (const name of w.split("+")) {
        midi(name);
        notes.push({ at: s * stepFrames, clip: t.instrument.note(name, length * stepSeconds) });
      }
    });
  }
  notes.sort((a, b) => a.at - b.at);
  // How many sound at once: at each note's start, those started before it and not yet over.
  let voices = 0;
  notes.forEach((n, k) => {
    let sounding = 0;
    for (let j = 0; j <= k; j++) if (notes[j].at + notes[j].clip.seconds / FRAME > n.at) sounding++;
    voices = Math.max(voices, sounding);
    if (sounding > VOICES) throw new Error(`At step ${n.at / stepFrames + 1}, ${sounding} notes would sound at once; the game plays ${VOICES}. Shorten notes or thin the chords.`);
  });
  const clips: Clip[] = [];
  const which = notes.map((n) => { let k = clips.indexOf(n.clip); if (k < 0) { clips.push(n.clip); k = clips.length - 1; } return k; });
  const length = Math.max(steps * stepFrames, ...notes.map((n) => n.at + Math.ceil(n.clip.seconds / FRAME)));
  return Object.freeze({
    stepFrames, bpm: 60 / (stepFrames * FRAME * perBeat), steps, frames: length, seconds: length * FRAME,
    clips: Object.freeze(clips), at: Object.freeze(notes.map((n) => n.at)), which: Object.freeze(which), voices,
  });
}

/** A song mixed into one clip when the script is built: every note exactly in time, one sound playing. */
export function render(s: Song): Clip {
  return mixdown(s.at.map((at, k) => ({ clip: s.clips[s.which[k]], at: at * FRAME })), s.seconds);
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
export const music = { sampler, synth, kit, track, song, render, play, loop };
