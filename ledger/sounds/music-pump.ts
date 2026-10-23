// ledger: step 5, takes
// A part that breathes with the beat, each note ducked on it: `{ fx: music.pump(beat) }`.
import { music } from "trigscript/music";
const pad = music.synth({ volume: 0.1, release: 0.05 });
const tune = music.song({ bpm: 120 }, music.track(pad, "C4+E4 - - -", { fx: music.pump(0.125) }));
program(async () => {
  await music.play(tune);
});
