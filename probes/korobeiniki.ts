// Step 2 of the music library's quality work, heard in StarCraft: Remastered: Korobeiniki (a Russian folk song, in
// the public domain; the melody only — the bass, the chords, the arpeggios, the counter-line and the drums are this
// file's own) arranged for the instruments and effects of "trigscript/music", mixed when the script is built. A is
// step 1's mix (plain waves, the same notes as before); B is the arrangement. Host it as a multiplayer game, alone,
// with the game's music off. It repeats.
//
//   npx tsx probes/lib/raycaster-map.mts fixtures/eud/sound-base.scx
//   npx tsx scripts/build-fixture.mts probes/korobeiniki.ts fixtures/eud/korobeiniki.scx fixtures/eud/sound-base.scx
import { music } from "trigscript/music";

/* ── The notes ── */

// The melody in eighths, a bar a string (the folk song's two phrases).
const MELODY = [
  "E5 - B4 C5 D5 - C5 B4", "A4 - A4 C5 E5 - D5 C5", "B4 - - C5 D5 - E5 -", "C5 - A4 - A4 - . .",
  "D5 - - F5 A5 - G5 F5", "E5 - - C5 E5 - D5 C5", "B4 - B4 C5 D5 - E5 -", "C5 - A4 - A4 - . .",
];
type Chord = readonly [root: string, fifth: string, notes: string];
const CHORDS: readonly Chord[] = [
  ["A1", "E2", "A3+C4+E4"], ["A1", "E2", "A3+C4+E4"], ["E1", "B1", "G#3+B3+E4"], ["A1", "E2", "A3+C4+E4"],
  ["D2", "A1", "A3+D4+F4"], ["C2", "G1", "G3+C4+E4"], ["E1", "B1", "G#3+B3+E4"], ["A1", "E2", "A3+C4+E4"],
];
const AM: Chord = CHORDS[0];

/** `x`, `n` times over. */
const times = <T,>(n: number, x: T): T[] => Array.from({ length: n }, () => x);
/** A note's name `by` octaves up or down. */
const octave = (note: string, by: number) => note.replace(/(-?\d)$/, (o) => String(Number(o) + by));
const chordUp = (notes: string, by: number) => notes.split("+").map((n) => octave(n, by)).join("+");
/** An eighth-note bar as sixteenths: each step twice as long. */
const sixteenths = (bar: string) => bar.split(" ").map((w) => (w === "." ? ". ." : `${w} -`)).join(" ");
const rest = (n = 1) => Array.from({ length: n }, () => times(16, ".").join(" "));
/** A bar of one held chord. */
const held = (notes: string) => [notes, ...times(15, "-")].join(" ");

// Sixteen steps a bar from here on.
const bassBar = ([r, f]: Chord) => [r, "-", ".", r, ".", r, r, "-", f, "-", ".", f, ".", octave(r, 1), r, "-"].join(" ");
const acidBar = ([r, f]: Chord) => {
  const R = octave(r, 1), F = octave(f, 1), O = octave(r, 2);
  return [R, ".", O, ".", F, R, ".", O, R, ".", F, ".", O, ".", R, F].join(" ");
};
const arpBar = ([, , notes]: Chord) => {
  const [a, b, c] = notes.split("+").map((n) => octave(n, 1));
  return [a, b, c, octave(a, 1), c, b, a, b, c, octave(a, 1), octave(b, 1), octave(a, 1), c, b, c, b].join(" ");
};

/** A bar of drums: the steps each letter plays on. */
const beat = (hits: Readonly<Record<string, readonly number[]>>) => Array.from({ length: 16 }, (_, i) => Object.keys(hits).filter((k) => hits[k].includes(i)).join("") || ".").join(" ");
const EIGHTHS = [0, 2, 4, 6, 8, 10, 12, 14], ALL = Array.from({ length: 16 }, (_, i) => i);
const GROOVE = beat({ k: [0, 7, 8, 10], s: [4, 12], h: EIGHTHS });
const DRIVE = beat({ k: [0, 7, 8, 10], s: [4, 12], c: [4, 12], h: ALL.filter((i) => i % 4 !== 2), o: [2, 6, 10, 14] });
const FILL = beat({ k: [0, 8], s: [4, 10, 11, 12, 13, 14, 15], t: [8, 9], h: [0, 2, 6] });
const BUILD = [beat({ h: EIGHTHS }), beat({ k: [0, 8], h: EIGHTHS, s: [12, 14, 15] })];

/* ── The instruments ── */

const lead = music.presets.lead({ volume: 0.15 });
const saw = music.presets.supersaw({ volume: 0.24 });
const bell = music.presets.bell({ volume: 0.035 });
const pad = music.presets.pad({ volume: 0.07 });
const bass = music.presets.bass({ volume: 0.38 });
const acid = music.presets.acid({ volume: 0.14 });
const keys = music.presets.keys({ volume: 0.11 });
const strum = music.presets.pluck({ volume: 0.15, decay: 0.9 });
const kit = music.drums();

const BEAT = 60 / 143;
const echo = (c: Clip) => c.delay(BEAT * 0.75, { feedback: 0.3, mix: 0.22, pingPong: true, tone: 4000 });

/* ── The arrangement: intro 4, A1 8, A2 8, break 4, A3 8, outro 2 ── */

const tune = MELODY.map(sixteenths);
const TRACKS = [
  // The melody: the lead in A1, the supersaw in A2 and A3; the bell an octave up in A2, A3 and the break.
  music.track(lead, [...rest(4), ...tune, ...rest(22)], { pan: -0.1, fx: echo, reverb: 0.25 }),
  music.track(saw, [...rest(12), ...tune, ...rest(4), ...tune, held("A4"), ...rest(1)], { fx: (c) => echo(c).chorus({ mix: 0.25 }), reverb: 0.3 }),
  music.track(bell, [...rest(12), ...tune.map((b) => b.replace(/[A-G]#?\d/g, (n) => octave(n, 1))), ...tune.slice(0, 4).map((b) => b.replace(/[A-G]#?\d/g, (n) => octave(n, 1))), ...tune.map((b) => b.replace(/[A-G]#?\d/g, (n) => octave(n, 1))), held("A5"), ...rest(1)], { pan: 0.3, reverb: 0.55 }),
  // Under it: the pad all through, the plucked arpeggio in the intro and A2, the keys in the break, the acid in A3.
  music.track(pad, [...CHORDS.slice(0, 4).map(([, , n]) => held(n)), ...[...CHORDS, ...CHORDS].map(([, , n]) => held(n)), ...CHORDS.slice(0, 4).map(([, , n]) => held(chordUp(n, 1))), ...CHORDS.map(([, , n]) => held(n)), held("A3+C4+E4"), ...rest(1)], { fx: (c) => c.filter("highpass", 180).chorus({ mix: 0.35 }), reverb: 0.5 }),
  music.track(strum, [...CHORDS.slice(0, 4).map(arpBar), ...rest(8), ...CHORDS.map(arpBar), ...rest(14)], { pan: 0.45, fx: (c) => c.delay(BEAT / 2, { feedback: 0.25, mix: 0.2, pingPong: true }), reverb: 0.35 }),
  music.track(keys, [...rest(20), ...CHORDS.slice(0, 4).map(([, , n]) => [n, "-", "-", ".", ".", ".", n, "-", ".", ".", n, "-", "-", "-", ".", "."].join(" ")), ...rest(10)], { pan: -0.2, fx: (c) => c.chorus({ mix: 0.3 }), reverb: 0.4 }),
  music.track(acid, [...rest(24), ...CHORDS.map(acidBar), ...rest(2)], { pan: -0.35, fx: echo, reverb: 0.15 }),
  music.track(bass, [...rest(2), bassBar(AM), bassBar(AM), ...CHORDS.map(bassBar), ...CHORDS.map(bassBar), ...CHORDS.slice(0, 4).map(([r]) => held(octave(r, 1))), ...CHORDS.map(bassBar), held("A1"), ...rest(1)], { fx: (c) => c.compress({ threshold: -20, ratio: 3 }) }),
  music.track(kit, [...rest(2), ...BUILD, ...times(7, GROOVE), FILL, ...times(7, DRIVE), FILL, ...rest(3), beat({ s: [8, 10, 12, 13, 14, 15], k: [0] }), ...times(7, DRIVE), FILL, beat({ k: [0], c: [0] }), ...rest(1)], { fx: (c) => c.compress({ threshold: -16, ratio: 3, attack: 0.003 }), reverb: 0.1 }),
];
const song = music.song({ bpm: 143, steps: 4 }, ...TRACKS);
const B = music.render(song, {
  reverb: { decay: 0.72, damping: 0.45, predelay: 0.02 },
  master: (mix) => mix.compress({ threshold: -14, ratio: 2, attack: 0.01, release: 0.15, makeup: 3 }).filter("highshelf", 9000, { gain: 1.5 }),
});

/* ── A: step 1's mix, as it was ── */

const STEP1 = MELODY;
const s1Bass = ([root, fifth]: readonly [string, string, string]) => `${root} - . ${root} ${fifth} . ${root} ${fifth}`;
const S1_CHORDS: readonly (readonly [string, string, string])[] = CHORDS.map(([r, f, n]) => [octave(r, 1), octave(f, 1), n]);
const s1Arp = ([, , notes]: readonly [string, string, string]) => { const [a, b, c] = notes.split("+").map((n) => octave(n, 1)); return `${a} ${b} ${c} ${b} ${a} ${b} ${c} ${b}`; };
const s1Rest = (bars: number) => Array.from({ length: bars }, () => ". . . . . . . .");
const s1Twice = <T,>(xs: readonly T[]) => [...xs, ...xs];
const s1Lead = music.synth({ wave: "square", volume: 0.2, decay: 0.12, sustain: 0.55, release: 0.1 });
const s1Low = music.synth({ wave: "saw", volume: 0.09, decay: 0.1, sustain: 0.5, release: 0.08 });
const s1BassI = music.synth({ wave: "triangle", volume: 0.55, attack: 0.003, decay: 0.15, sustain: 0.6, release: 0.05 });
const s1ArpI = music.synth({ wave: "triangle", volume: 0.16, decay: 0.12, sustain: 0.2, release: 0.1 });
const s1Pad = music.synth({ wave: "triangle", volume: 0.09, attack: 0.12, decay: 0.3, sustain: 0.8, release: 0.4 });
const s1Drums = music.kit({
  k: tone(140, 0.03, { volume: 0.8 }).then(tone(85, 0.05, { volume: 0.8 }), tone(55, 0.12, { volume: 0.7 })).fade(0, 0.14),
  s: noise(0.16, { volume: 0.4 }).fade(0, 0.15).mix(tone(200, 0.08, { volume: 0.35 }).fade(0, 0.07)),
  h: noise(0.04, { volume: 0.14 }).fade(0, 0.035),
});
const s1Pads = (bar: readonly [string, string, string]) => `${bar[2]} - - - - - - -`;
const before = music.song({ bpm: 143, steps: 2 },
  music.track(s1Lead, [...s1Rest(2), ...s1Twice(STEP1), "A4 - - - . . . ."], { pan: -0.15 }),
  music.track(s1Low, [...s1Rest(10), ...STEP1.map((bar) => bar.replace(/[A-G]#?\d/g, (n) => octave(n, -1))), ". . . . . . . ."], { pan: 0.45 }),
  music.track(s1BassI, [...s1Twice(S1_CHORDS).slice(0, 2).map(s1Bass), ...s1Twice(S1_CHORDS).map(s1Bass), "A2 - - - . . . ."]),
  music.track(s1ArpI, [...s1Rest(2), ...S1_CHORDS.map(() => ". . . . . . . ."), ...S1_CHORDS.map(s1Arp), ". . . . . . . ."], { pan: 0.6 }),
  music.track(s1Pad, [...s1Rest(2), ...s1Twice(S1_CHORDS).map(s1Pads), "A3+C4+E4 - - - - - - -"], { pan: -0.5 }),
  music.track(s1Pad, [...s1Rest(2), ...s1Twice(S1_CHORDS).map((c) => s1Pads(c).replace(/(\d)(?=[+ ])/g, (o) => String(Number(o) + 1))), ". . . . . . . ."], { pan: 0.5, volume: 0.6 }),
  music.track(s1Drums, ["k h h h s h kh h", "k h s h s s s s", ...Array.from({ length: 15 }, () => "k h h h s h kh h"), "k h s h s s s s", "k . . . . . . ."]),
);
const A = music.render(before);

const PARK = reserveLocation("korobeiniki: the camera");

program(async () => {
  removeUnit(P1, units.AnyUnit);
  removeUnit(P2, units.AnyUnit);
  centerLocation(PARK, 64 * 32, 112 * 32);
  centerView(PARK);
  displayText(`\x04Korobeiniki: A (${Math.round(A.seconds)} s) then B (${Math.round(B.seconds)} s), ${Math.round(song.bpm)} beats a minute. Turn the game's music off. It repeats.`);
  await sleep(frames(96));
  while (true) {
    displayText("\x04A: step 1. Plain waves, the same notes as last time.");
    playWav(A, 0);
    await sleep(frames(Math.ceil(A.seconds / 0.042) + 72));
    displayText("\x04B: step 2. The arrangement: filters, supersaws, FM, plucks, the drum kit, echoes, chorus, reverb, the master.");
    playWav(B, 0);
    await sleep(frames(Math.ceil(B.seconds / 0.042) + 96));
  }
});
