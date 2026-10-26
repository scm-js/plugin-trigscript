// ledger: step 5, takes
// A pattern played several times over, when the map is built: `music.repeat(pattern, 2)`.
import { music } from "trigscript/music";
const lead = music.synth({ release: 0.05 });
const tune = music.song({ bpm: 120 }, music.track(lead, music.repeat("C5 G4", 2)));
program(async () => {
  await music.play(tune);
});
