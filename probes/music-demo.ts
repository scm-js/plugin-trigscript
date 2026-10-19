// "trigscript/music" played in StarCraft: Remastered: Ode to Joy (Beethoven, in the public domain) in four tracks — a
// square-wave lead, a bass from the plucked string, triangle-wave chords and a kit of noise and tones — first note by
// note (music.play: a note a playWav on its frame), then mixed into one clip when the script is built (music.render:
// one sound, every note exactly in time). Host it as a multiplayer game, alone, with the game's music off. It repeats.
//
//   npx tsx probes/lib/sound-demo-gen.mts
//   npx tsx probes/lib/raycaster-map.mts fixtures/eud/sound-base.scx
//   npx tsx scripts/build-fixture.mts probes/music-demo.ts fixtures/eud/music-demo.scx fixtures/eud/sound-base.scx
import { music } from "trigscript/music";
import pluck from "./pluck.sound";

const lead = music.synth({ wave: "square", volume: 0.16, decay: 0.1, sustain: 0.6, release: 0.08 });
const pad = music.synth({ wave: "triangle", volume: 0.07, attack: 0.05, decay: 0.2, sustain: 0.8, release: 0.25 });
const bass = music.sampler(pluck, "A3", { volume: 0.45, release: 0.08 });
const drums = music.kit({
  k: tone(110, 0.04, { volume: 0.5 }).then(tone(70, 0.08, { volume: 0.5 }), tone(50, 0.1, { volume: 0.4 })).fade(0, 0.12),
  s: noise(0.14, { volume: 0.3 }).fade(0, 0.13).mix(tone(190, 0.07, { volume: 0.2 }).fade(0, 0.06)),
  h: noise(0.03, { volume: 0.1 }).fade(0, 0.025),
});

// Eighth notes: two steps a beat, a bar of eight steps.
const MELODY = [
  "E5 - E5 - F5 - G5 -", "G5 - F5 - E5 - D5 -", "C5 - C5 - D5 - E5 -", "E5 - - D5 D5 - - -",
  "E5 - E5 - F5 - G5 -", "G5 - F5 - E5 - D5 -", "C5 - C5 - D5 - E5 -", "D5 - - C5 C5 - - -",
];
const BASS = [
  "C3 - - - C3 - - -", "G2 - - - G2 - - -", "C3 - - - C3 - - -", "G2 - - - G2 - - -",
  "C3 - - - C3 - - -", "G2 - - - G2 - - -", "C3 - - - C3 - - -", "G2 - - C3 - - - -",
];
const C = "C4+E4+G4 - - - - - - -", G = "B3+D4+G4 - - - - - - -";
const CHORDS = [C, G, C, G, C, G, C, "B3+D4+G4 - - C4+E4+G4 - - - -"];
const BEAT = "k . h . s . h .";

const ode = music.song({ bpm: 100, steps: 2 },
  music.track(lead, MELODY),
  music.track(bass, BASS),
  music.track(pad, CHORDS),
  music.track(drums, Array.from({ length: 8 }, () => BEAT)),
);
const mixed = music.render(ode);
if (mixed.peak > 1) throw new Error(`The mix peaks at ${mixed.peak.toFixed(2)}: turn something down.`);

const PARK = reserveLocation("music demo: the camera");

program(async () => {
  removeUnit(P1, units.AnyUnit);
  removeUnit(P2, units.AnyUnit);
  centerLocation(PARK, 64 * 32, 112 * 32);
  centerView(PARK);
  displayText("\x04Music demo: Ode to Joy in four tracks. Turn the game's music off. It repeats.");
  await sleep(frames(96));
  while (true) {
    displayText(`\x04A: note by note (music.play), ${ode.clips.length} clips, ${Math.round(ode.bpm)} beats a minute.`);
    await music.play(ode);
    await sleep(frames(48));
    displayText("\x04B: the same song mixed into one clip when the script was built (music.render).");
    playWav(mixed, 0);
    await sleep(frames(ode.frames + 48));
    displayText("\x04C: the lead on its own, as a sound effect: lead.note(\"C6\", 0.1), three times.");
    playWav(lead.note("C6", 0.1), 0);
    await sleep(frames(4));
    playWav(lead.note("E6", 0.1), 0);
    await sleep(frames(4));
    playWav(lead.note("G6", 0.2), 0);
    await sleep(frames(72));
  }
});
