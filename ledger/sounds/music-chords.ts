// ledger: step 5, takes
// A chord progression by name, each drawn by a template: `music.chords("Am F", "1+2+3 - . .")`.
import { music } from "trigscript/music";
const keys = music.synth({ volume: 0.1, release: 0.05 });
const tune = music.song({ bpm: 120 }, music.track(keys, music.chords("Am F", "1+2+3 - . .")));
program(async () => {
  await music.play(tune);
});
