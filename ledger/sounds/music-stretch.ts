// ledger: step 5, takes
// A pattern made slower, each step held longer, when the map is built: `music.stretch(pattern, 2)`.
import { music } from "trigscript/music";
const lead = music.synth({ release: 0.05 });
const tune = music.song({ bpm: 120 }, music.track(lead, music.stretch("C5 E5", 2)));
program(async () => {
  await music.play(tune);
});
