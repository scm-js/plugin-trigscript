// ledger: step 5, takes
// An FM instrument: `music.fmSynth({ ratio, index })`.
import { music } from "trigscript/music";
const keys = music.fmSynth({ ratio: 1, index: 2, release: 0.1 });
const tune = music.song({ bpm: 120 }, music.track(keys, "E4 - G4 -"));
program(async () => {
  await music.play(tune);
});
