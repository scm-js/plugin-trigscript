// Step 4 of the music library's quality work, heard in StarCraft: Remastered: Korobeiniki (a Russian folk song, in
// the public domain; the melody only — the rest is this file's own), step 3's arrangement cut into bars and layers
// (`music.stems`) and played bar by bar as the program says (`Band`, `music.conduct`): music that follows the game.
// Left alone it plays the song through, bar by bar, and starts again; the keys steer it. Host it as a multiplayer
// game, alone, with the game's music off.
//
//   1 … 7   go to a section at the next bar line: intro, verse, build, drop, break, last verse, outro
//   D B H M the drums, the bass, the harmony (pad, arpeggio, piano), the melody: off or on from the next bar line
//   L       a section plays again when it ends (or goes on to the next)
//   Space   a crash on the next bar line
//
//   npx tsx probes/lib/raycaster-map.mts fixtures/eud/sound-base.scx
//   npx tsx scripts/build-fixture.mts probes/korobeiniki-band.ts fixtures/eud/korobeiniki-band.scx fixtures/eud/sound-base.scx
import { music, Band } from "trigscript/music";
/* ── The notes ── */

// The melody in eighths, a bar a string (the folk song's two phrases).
const MELODY = [
  "E5 - B4 C5 D5 - C5 B4", "A4 - A4 C5 E5 - D5 C5", "B4 - - C5 D5 - E5 -", "C5 - A4 - A4 - . .",
  "D5 - - F5 A5 - G5 F5", "E5 - - C5 E5 - D5 C5", "B4 - B4 C5 D5 - E5 -", "C5 - A4 - A4 - . .",
];
const tune = music.stretch(MELODY, 2) as readonly string[];
const BEAT = 60 / 143;
const echo = (c: Clip) => c.delay(BEAT * 0.75, { feedback: 0.3, mix: 0.22, pingPong: true, tone: 4000 });
/** `x`, `n` times over. */
const times = <T,>(n: number, x: T): T[] => Array.from({ length: n }, () => x);
const REST = times(16, ".").join(" ");
const rest = (n = 1) => times(n, REST);
/** A bar of one held chord. */
const held = (notes: string) => [notes, ...times(15, "-")].join(" ");

/* ── Step 2's helpers ── */

type Chord = readonly [root: string, fifth: string, notes: string];
const CHORDS: readonly Chord[] = [
  ["A1", "E2", "A3+C4+E4"], ["A1", "E2", "A3+C4+E4"], ["E1", "B1", "G#3+B3+E4"], ["A1", "E2", "A3+C4+E4"],
  ["D2", "A1", "A3+D4+F4"], ["C2", "G1", "G3+C4+E4"], ["E1", "B1", "G#3+B3+E4"], ["A1", "E2", "A3+C4+E4"],
];
const AM: Chord = CHORDS[0];
const up = (note: string, by: number) => note.replace(/(-?\d)$/, (o) => String(Number(o) + by));
const chordUp = (notes: string, by: number) => notes.split("+").map((n) => up(n, by)).join("+");
const bassBar = ([r, f]: Chord) => [r, "-", ".", r, ".", r, r, "-", f, "-", ".", f, ".", up(r, 1), r, "-"].join(" ");
const acidBar = ([r, f]: Chord) => {
  const R = up(r, 1), F = up(f, 1), O = up(r, 2);
  return [R, ".", O, ".", F, R, ".", O, R, ".", F, ".", O, ".", R, F].join(" ");
};
const arpBar = ([, , notes]: Chord) => {
  const [a, b, c] = notes.split("+").map((n) => up(n, 1));
  return [a, b, c, up(a, 1), c, b, a, b, c, up(a, 1), up(b, 1), up(a, 1), c, b, c, b].join(" ");
};
const EIGHTHS = [0, 2, 4, 6, 8, 10, 12, 14], ALL = Array.from({ length: 16 }, (_, i) => i);
const GROOVE = music.beat({ k: [0, 7, 8, 10], s: [4, 12], h: EIGHTHS });
const DRIVE = music.beat({ k: [0, 7, 8, 10], s: [4, 12], c: [4, 12], h: ALL.filter((i) => i % 4 !== 2), o: [2, 6, 10, 14] });
const FILL = music.beat({ k: [0, 8], s: [4, 10, 11, 12, 13, 14, 15], t: [8, 9], h: [0, 2, 6] });
const BUILD = [music.beat({ h: EIGHTHS }), music.beat({ k: [0, 8], h: EIGHTHS, s: [12, 14, 15] })];
const pads = (list: readonly Chord[]) => list.map(([, , n]) => held(n));
const octaveUp = (bars: readonly string[]) => music.transpose(bars, 12) as readonly string[];

const ROOM = { decay: 0.72, damping: 0.45, predelay: 0.02 };

/* ── Step 3's arrangement ── */

const PROG = "Am Am E Am Dm C E Am";
const HALF = "Am Am E Am";
const BAR = music.bars(143), SPB = BAR / 4;
// A chord a bar, voiced near the one before; the arpeggio, the bass and the acid line drawn over each chord by number.
const padBars = (p: string, octave = 3) => music.chords(p, held("1+2+3"), { octave, lead: true });
const arps = (p: string) => music.chords(p, "1 2 3 4 3 2 1 2 3 4 5 4 3 2 3 2", { octave: 4, lead: true });
const BASS = "1 - . 1 . 1 1 - 3 - . 3 . 1^ 1 -";
const bassOf = (p: string) => music.chords(p, BASS, { octave: 1 }).map((bar, k) => ("CD".includes(music.chords(p, "1")[k][0]) ? music.transpose(bar, 12) as string : bar));
const acidOf = (p: string) => music.chords(p, "1^ . 1^^ . 3^ 1^ . 1^^ 1^ . 3^ . 1^^ . 1^ 3^", { octave: 1 }).map((bar) => bar);
const hatsBar = (open: boolean) => times(4, `h@0.45 h@0.22 ${open ? "o@0.55" : "h@0.8"} h@0.25`).join(" ");
// The snare roll of the build: eighths, then sixteenths, louder bar by bar.
const roll = [
  music.beat({ k: [0, 4, 8, 12], s: [4, 12] }),
  music.beat({ k: [0, 4, 8, 12], s: [0, 2, 4, 6, 8, 10, 12, 14] }),
  ALL.map((i) => (i % 4 === 0 ? "ks" : "s") + `@${(0.45 + i * 0.02).toFixed(2)}`).join(" "),
  ALL.map((i) => (i < 12 ? "s" : ".") + (i < 12 ? `@${(0.75 + i * 0.02).toFixed(2)}` : "")).join(" "),
];
const FLOOR = music.beat({ k: [0, 4, 8, 12], s: [4, 12], c: [4, 12] });
const FLOOR_FILL = music.beat({ k: [0, 4, 8, 10], s: [4, 12, 13, 14, 15], c: [4], t: [10, 11] });
const sweep = (from: number, to: number) => (c: Clip, t: { seconds: number }) => c.filter("lowpass", [[0, from], [t.seconds, to]], { resonance: 0.2 });
const kit = music.drums({ volume: 0.6 });
const crash = kit.hits.x;
const fxKit = music.kit({
  r: music.riser(music.bars(143, 4), { volume: 0.32 }),
  q: music.riser(music.bars(143, 2), { volume: 0.3 }),
  i: music.impact({ volume: 0.55 }),
  // A crash backwards: swelling into the bar after.
  z: crash.trim(0, BAR).reverse().fade(0.4, 0.005),
});
const pumping = music.pump(SPB, 0.5);
const up2 = (p: readonly string[]) => music.transpose(p, 2) as readonly string[];

const parts = {
  lead: music.part(music.presets.lead({ volume: 0.15 }), { pan: -0.1, fx: echo, reverb: 0.25 }),
  saw: music.part(music.presets.supersaw({ volume: 0.24 }), { fx: (c) => echo(c).chorus({ mix: 0.25 }), reverb: 0.3 }),
  bell: music.part(music.presets.bell({ volume: 0.035 }), { pan: 0.3, reverb: 0.55 }),
  pad: music.part(music.presets.pad({ volume: 0.075 }), { fx: (c) => c.filter("highpass", 180).chorus({ mix: 0.35 }), reverb: 0.5 }),
  strum: music.part(music.presets.pluck({ volume: 0.15, decay: 0.9 }), { pan: 0.45, fx: (c) => c.delay(BEAT / 2, { feedback: 0.25, mix: 0.2, pingPong: true }), reverb: 0.35 }),
  keys: music.part(music.presets.keys({ volume: 0.11 }), { pan: -0.2, fx: (c) => c.chorus({ mix: 0.3 }), reverb: 0.4 }),
  acid: music.part(music.presets.acid({ volume: 0.13 }), { pan: -0.35, fx: echo, reverb: 0.15 }),
  bass: music.part(music.presets.bass({ volume: 0.38 }), { fx: (c) => c.compress({ threshold: -20, ratio: 3 }) }),
  kit: music.part(kit, { fx: (c) => c.compress({ threshold: -16, ratio: 3, attack: 0.003 }), reverb: 0.1 }),
  hats: music.part(kit, { pan: 0.15, reverb: 0.08 }),
  fx: music.part(fxKit, { reverb: 0.35 }),
};

const intro = music.section(4, {
  pad: padBars(HALF), strum: arps(HALF), bass: [...rest(2), ...bassOf("Am Am")],
  hats: [REST, REST, times(8, "h@0.3 .").join(" "), hatsBar(false)], fx: [REST, REST, REST, "z" + " .".repeat(15)],
}, { name: "intro", fx: { pad: sweep(300, 9000), strum: sweep(500, 12000) } });
const verse = music.section(8, {
  lead: tune, pad: padBars(PROG), bass: bassOf(PROG),
  kit: [GROOVE.replace(/^k/, "kx"), ...times(6, GROOVE), FILL], hats: hatsBar(false),
}, { name: "verse", volume: { lead: 0.8, pad: 0.55, bass: 0.75, kit: 0.7, hats: 0.7 } });
const build = music.section(4, {
  bell: octaveUp(tune.slice(0, 4)), pad: padBars(HALF), strum: arps(HALF),
  bass: music.chords(HALF, "1 . 1 . 1 . 1 . 1 . 1 . 1 . 1 .", { octave: 1 }),
  kit: roll, hats: [hatsBar(false), hatsBar(false), times(16, "h@0.5").join(" "), REST], fx: "r" + " .".repeat(63),
}, { name: "build", fx: { pad: sweep(400, 12000), strum: sweep(800, 14000) }, volume: { bass: 0.8 } });
const drop = music.section(8, {
  saw: tune, bell: octaveUp(tune), pad: padBars(PROG), strum: arps(PROG), bass: bassOf(PROG),
  kit: [FLOOR.replace(/^k/, "kx"), ...times(6, FLOOR), FLOOR_FILL], hats: hatsBar(true), fx: ["i" + " .".repeat(15), ...rest(7)],
}, { name: "drop", fx: { pad: pumping, bass: pumping, strum: pumping } });
const breakdown = music.section(4, {
  bell: octaveUp(tune.slice(4, 8)), pad: padBars("Dm C E Am", 4),
  keys: music.chords("Dm C E Am", "1+2+3 - - . . . 1+2+3 - . . 1+2+3 - - - . .", { octave: 3, lead: true }),
  bass: music.chords("Dm C E Am", held("1"), { octave: 2 }),
  kit: [REST, REST, music.beat({ k: [0, 8] }), music.beat({ k: [0], s: [8, 10, 12, 13, 14, 15] })],
  hats: [REST, REST, times(8, "h@0.35 .").join(" "), hatsBar(false)], fx: [REST, REST, "q" + " .".repeat(15), REST],
}, { name: "break", volume: { pad: 0.45, keys: 0.7, bass: 0.6, bell: 0.8 } });
const last = music.section(8, {
  saw: up2(tune), bell: up2(octaveUp(tune)), pad: up2(padBars(PROG)), acid: up2(acidOf(PROG)), bass: up2(bassOf(PROG)),
  kit: [FLOOR.replace(/^k/, "kx"), ...times(6, FLOOR), FLOOR_FILL], hats: hatsBar(true), fx: ["i" + " .".repeat(15), ...rest(7)],
}, { name: "last verse, a tone up", fx: { pad: pumping, bass: pumping } });
const outro = music.section(4, {
  saw: [held("B4"), ...rest(3)], bell: [held("B5"), ...rest(3)], pad: up2([held("A3+C4+E4"), held("A3+C4+E4"), ...rest(2)]),
  bass: [held("B1"), ...rest(3)], kit: [music.beat({ k: [0], x: [0] }), ...rest(3)], fx: ["i" + " .".repeat(15), ...rest(3)],
}, { name: "outro", fx: { pad: (c, t) => c.filter("lowpass", [[0, 6000], [t.seconds, 250]]) } });

const step3 = music.arrange({ bpm: 143, steps: 4, swing: 0.08 }, parts, intro, verse, build, drop, breakdown, last, outro);

/* ── Cut for the game ── */

const LAYERS = ["drums", "bass", "harmony", "melody"];
const st = music.stems(step3, {
  layers: { drums: ["kit", "hats", "fx"], bass: ["bass"], harmony: ["pad", "strum", "keys"], melody: ["lead", "saw", "bell", "acid"] },
  reverb: ROOM,
  master: (c) => c.filter("highshelf", 9000, { gain: 1.5 }),
  stingers: { crash: crash.gain(0.7) },
});
const NAMES = st.sections.map((x) => x.name);
const KEYS = ["1", "2", "3", "4", "5", "6", "7"] as const;
const LAYER_KEYS = ["D", "B", "H", "M"] as const;

const PARK = reserveLocation("korobeiniki: the camera");

program(async () => {
  removeUnit(P1, units.AnyUnit);
  removeUnit(P2, units.AnyUnit);
  centerLocation(PARK, 64 * 32, 112 * 32);
  centerView(PARK);
  displayText(`\x04Korobeiniki, bar by bar: ${st.sections.length} sections, ${st.layers.length} layers, ${st.voices} sounds at once at most. Game music off.`);
  displayText("\x04Let it play through once untouched, then: 1-7 a section, D B H M a layer, L loop, Space a crash.");
  await sleep(frames(72));
  const band = new Band();
  start(music.conduct(st, band));
  let shown = -1;
  while (true) {
    for (let k = 0; k < KEYS.length; k++) if (keyPressed(P1, KEYS[k])) { band.go(k); displayText(`\x04→ ${NAMES[k]} at the next bar`); }
    for (let l = 0; l < LAYER_KEYS.length; l++) if (keyPressed(P1, LAYER_KEYS[l])) {
      band.on[l] = !band.on[l];
      if (band.on[l]) displayText(`\x04${LAYERS[l]} on`); else displayText(`\x04${LAYERS[l]} off`);
    }
    if (keyPressed(P1, "L")) {
      band.loop = !band.loop;
      if (band.loop) displayText("\x04each section plays again"); else displayText("\x04on through the song");
    }
    if (keyPressed(P1, "Space")) band.sting(0);
    if (band.section !== shown) {
      shown = band.section;
      for (let k = 0; k < NAMES.length; k++) if (band.section === k) displayText(`\x03${NAMES[k]}`);
    }
    await nextFrame();
  }
});
