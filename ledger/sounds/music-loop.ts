// ledger: step 11, takes
// A song played again and again beside the program: `start(music.loop(song))`.
import { music } from "trigscript/music";
const lead = music.synth({ release: 0.05 });
const tune = music.song({ bpm: 120 }, music.track(lead, "C5 . E5 ."));
program(async () => {
  start(music.loop(tune));
});
