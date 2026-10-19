// Sounds a script imports and makes, played in StarCraft: Remastered: an imported sound as it is and as a scale, a
// melody of square-wave notes, drums made of noise and a falling tone, a chord mixed into one clip, and the import
// reversed — every clip made when the script is built and put in the map once. Each part is said on screen.
// Host it as a multiplayer game, alone, with the game's music off. It repeats.
//
//   npx tsx probes/lib/sound-demo-gen.mts
//   npx tsx probes/lib/raycaster-map.mts fixtures/eud/sound-base.scx
//   npx tsx scripts/build-fixture.mts probes/sound-demo.ts fixtures/eud/sound-demo.scx fixtures/eud/sound-base.scx
import pluck from "./pluck.sound";

/** A frame on Fastest is 42 ms; a beat here is 8 of them, a third of a second. */
const BEAT = 8;

// B: the pluck as a scale, A3 up an octave: a sampler's notes, each a copy made at build.
const SCALE = [0, 2, 4, 5, 7, 9, 11, 12].map((n) => pluck.pitch(n).trim(0, 0.6).fade(0, 0.1));

// C: a melody (Twinkle, Twinkle), square waves with a short tail.
const note = (name: string) => tone(name, 0.28, { wave: "square", volume: 0.25 }).fade(0.005, 0.12);
const MELODY = ["C5", "C5", "G5", "G5", "A5", "A5", "G5", "-", "F5", "F5", "E5", "E5", "D5", "D5", "C5", "-"];
// A rest is a moment of silence: `if (clip)` is not yet decided at build, so every step plays something.
const REST = silence(0.05);
const NOTES = MELODY.map((n) => (n === "-" ? REST : note(n)));

// D: drums — a kick that falls from 120 Hz, a snare of noise, a closed hat of quiet noise.
const KICK = tone(120, 0.05, { volume: 0.8 }).then(tone(70, 0.1, { volume: 0.8 })).then(tone(50, 0.15, { volume: 0.6 })).fade(0, 0.15);
const SNARE = noise(0.15, { volume: 0.5 }).fade(0, 0.14).mix(tone(200, 0.08, { volume: 0.3 }).fade(0, 0.07));
const HAT = noise(0.04, { volume: 0.2 }).fade(0, 0.035);
const BEATS = ["kh", "h", "sh", "h", "kh", "kh", "sh", "h"];

// E: a C major chord, three tones mixed into one clip, and the same chord arpeggiated with silence between.
const CHORD = tone("C4", 1.2, { volume: 0.2, wave: "triangle" }).mix(tone("E4", 1.2, { volume: 0.2, wave: "triangle" })).mix(tone("G4", 1.2, { volume: 0.2, wave: "triangle" })).fade(0.02, 0.5);
const ARPEGGIO = tone("C4", 0.2, { volume: 0.3 }).fade(0, 0.05).then(silence(0.05), tone("E4", 0.2, { volume: 0.3 }).fade(0, 0.05), silence(0.05), tone("G4", 0.2, { volume: 0.3 }).fade(0, 0.05), silence(0.05), tone("C5", 0.4, { volume: 0.3 }).fade(0, 0.3));

// F: the pluck backwards, then twice as fast.
const BACKWARDS = pluck.reverse();
const FAST = pluck.pitch(12).repeat(2);

const PARK = reserveLocation("sound demo: the camera");

program(async () => {
  removeUnit(P1, units.AnyUnit);
  removeUnit(P2, units.AnyUnit);
  centerLocation(PARK, 64 * 32, 112 * 32);
  centerView(PARK);
  displayText("\x04Sound demo: clips a script imports and makes. Turn the game's music off. It repeats.");
  await sleep(frames(120));
  while (true) {
    displayText("\x04A: an imported sound, a plucked string, as it is.");
    playWav(pluck, 0);
    await sleep(frames(60));

    displayText("\x04B: the same sound as a scale, pitched at build.");
    for (const n of SCALE) { playWav(n, 0); await sleep(frames(BEAT)); }
    await sleep(frames(36));

    displayText("\x04C: a melody of square-wave notes made with tone().");
    for (const n of NOTES) { playWav(n, 0); await sleep(frames(BEAT)); }
    await sleep(frames(24));

    displayText("\x04D: drums made of noise and a falling tone, two bars.");
    let bar = 0;
    while (bar < 2) {
      for (const b of BEATS) {
        if (b.includes("k")) playWav(KICK, 0);
        if (b.includes("s")) playWav(SNARE, 0);
        if (b.includes("h")) playWav(HAT, 0);
        await sleep(frames(BEAT / 2));
      }
      bar++;
    }
    await sleep(frames(24));

    displayText("\x04E: a chord mixed into one clip, then the same notes one after another.");
    playWav(CHORD, 0);
    await sleep(frames(36));
    playWav(ARPEGGIO, 0);
    await sleep(frames(48));

    displayText("\x04F: the plucked string backwards, then an octave up twice.");
    playWav(BACKWARDS, 0);
    await sleep(frames(42));
    playWav(FAST, 0);
    await sleep(frames(60));
  }
});
