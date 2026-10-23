// The music library's first quality step, heard in StarCraft: Remastered: Korobeiniki (a Russian folk song, in the
// public domain; the melody only — the bass, the chords, the arpeggio and the drums are this file's own) mixed when
// the script is built, twice. A is how a mix went in before: 22 050 Hz, one channel, as a WAV, turned down so it does
// not clip. B is the same notes made again at 44 100 Hz, the tracks spread left and right, through the limiter, as Ogg
// Vorbis. Host it as a multiplayer game, alone, with the game's music off. It repeats.
//
//   npx tsx probes/lib/raycaster-map.mts fixtures/eud/sound-base.scx
//   npx tsx scripts/build-fixture.mts probes/korobeiniki-ab.ts fixtures/eud/korobeiniki-ab.scx fixtures/eud/sound-base.scx
import { music } from "trigscript/music";

// Eighth notes: two steps a beat, eight a bar; five frames a step is 143 beats a minute.
const MELODY = [
  "E5 - B4 C5 D5 - C5 B4", "A4 - A4 C5 E5 - D5 C5", "B4 - - C5 D5 - E5 -", "C5 - A4 - A4 - . .",
  "D5 - - F5 A5 - G5 F5", "E5 - - C5 E5 - D5 C5", "B4 - B4 C5 D5 - E5 -", "C5 - A4 - A4 - . .",
];
/** A bar a chord: its root low, and its notes. */
const CHORDS: readonly (readonly [string, string, string])[] = [
  ["A2", "E3", "A3+C4+E4"], ["A2", "E3", "A3+C4+E4"], ["E2", "B2", "G#3+B3+E4"], ["A2", "E3", "A3+C4+E4"],
  ["D2", "A2", "A3+D4+F4"], ["C2", "G2", "G3+C4+E4"], ["E2", "B2", "G#3+B3+E4"], ["A2", "E3", "A3+C4+E4"],
];
const bassBar = ([root, fifth]: readonly [string, string, string]) => `${root} - . ${root} ${fifth} . ${root} ${fifth}`;
const arpBar = ([, , notes]: readonly [string, string, string]) => {
  const [a, b, c] = notes.split("+").map((n) => n.slice(0, -1) + (Number(n.slice(-1)) + 1));
  return `${a} ${b} ${c} ${b} ${a} ${b} ${c} ${b}`;
};
const padBar = ([, , notes]: readonly [string, string, string]) => `${notes} - - - - - - -`;

const lead = music.synth({ wave: "square", volume: 0.2, decay: 0.12, sustain: 0.55, release: 0.1 });
const low = music.synth({ wave: "saw", volume: 0.09, decay: 0.1, sustain: 0.5, release: 0.08 });
const bass = music.synth({ wave: "triangle", volume: 0.55, attack: 0.003, decay: 0.15, sustain: 0.6, release: 0.05 });
const arp = music.synth({ wave: "triangle", volume: 0.16, decay: 0.12, sustain: 0.2, release: 0.1 });
const pad = music.synth({ wave: "triangle", volume: 0.09, attack: 0.12, decay: 0.3, sustain: 0.8, release: 0.4 });
const drums = music.kit({
  k: tone(140, 0.03, { volume: 0.8 }).then(tone(85, 0.05, { volume: 0.8 }), tone(55, 0.12, { volume: 0.7 })).fade(0, 0.14),
  s: noise(0.16, { volume: 0.4 }).fade(0, 0.15).mix(tone(200, 0.08, { volume: 0.35 }).fade(0, 0.07)),
  h: noise(0.04, { volume: 0.14 }).fade(0, 0.035),
});

const rest = (bars: number) => Array.from({ length: bars }, () => ". . . . . . . .");
const twice = <T,>(xs: readonly T[]) => [...xs, ...xs];
const BEAT = "k h h h s h kh h", FILL = "k h s h s s s s";
const tracks = (wide: boolean) => [
  music.track(lead, [...rest(2), ...twice(MELODY), "A4 - - - . . . ."], { pan: wide ? -0.15 : 0 }),
  music.track(low, [...rest(10), ...MELODY.map((bar) => bar.replace(/([A-G]#?)(\d)/g, (_, n: string, o: string) => n + (Number(o) - 1))), ". . . . . . . ."], { pan: wide ? 0.45 : 0 }),
  music.track(bass, [...twice(CHORDS).slice(0, 2).map(bassBar), ...twice(CHORDS).map(bassBar), "A2 - - - . . . ."]),
  music.track(arp, [...rest(2), ...CHORDS.map(() => ". . . . . . . ."), ...CHORDS.map(arpBar), ". . . . . . . ."], { pan: wide ? 0.6 : 0 }),
  music.track(pad, [...rest(2), ...twice(CHORDS).map(padBar), "A3+C4+E4 - - - - - - -"], { pan: wide ? -0.5 : 0 }),
  music.track(pad, [...rest(2), ...twice(CHORDS).map((c) => padBar(c).replace(/(\d)(?=[+ ])/g, (o) => String(Number(o) + 1))), ". . . . . . . ."], { pan: wide ? 0.5 : 0, volume: 0.6 }),
  music.track(drums, [BEAT, FILL, ...Array.from({ length: 15 }, () => BEAT), FILL, "k . . . . . . ."]),
];

const before = music.song({ bpm: 144, steps: 2 }, ...tracks(false));
const after = music.song({ bpm: 144, steps: 2 }, ...tracks(true));
const mixedA = music.render(before, { rate: 22050, limit: false });
// A: as a mix went in before — one channel at 22 050, as a WAV, and turned down until it no longer clips.
const A = (mixedA.peak > 1 ? mixedA.gain(0.98 / mixedA.peak) : mixedA).wav();
const B = music.render(after);

const PARK = reserveLocation("korobeiniki: the camera");

program(async () => {
  removeUnit(P1, units.AnyUnit);
  removeUnit(P2, units.AnyUnit);
  centerLocation(PARK, 64 * 32, 112 * 32);
  centerView(PARK);
  displayText(`\x04Korobeiniki, A then B, ${Math.round(after.bpm)} beats a minute, ${Math.round(B.seconds)} seconds each. Turn the game's music off. It repeats.`);
  await sleep(frames(96));
  while (true) {
    displayText(`\x04A: as before. 22 kHz, one channel, a WAV, turned down to fit (peak ${mixedA.peak.toFixed(2)} before).`);
    playWav(A, 0);
    await sleep(frames(Math.ceil(A.seconds / 0.042) + 72));
    displayText("\x04B: 44 kHz, left and right, the limiter, Ogg Vorbis.");
    playWav(B, 0);
    await sleep(frames(Math.ceil(B.seconds / 0.042) + 72));
  }
});
