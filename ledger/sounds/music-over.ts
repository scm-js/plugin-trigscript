// ledger: step 5, takes
// A chord's notes drawn by a template, when the map is built: `music.over("C4+E4+G4", "1 2 3 2")`.
import { music } from "trigscript/music";
const lead = music.synth({ release: 0.05 });
const tune = music.song({ bpm: 120 }, music.track(lead, music.over("C4+E4+G4", "1 2 3 2")));
program(async () => {
  await music.play(tune);
});
