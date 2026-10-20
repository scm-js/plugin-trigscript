// ledger: step 5, refused: the action Play WAV
// A song played note by note from the music library: `music.synth`, `music.track`, `music.song`, and
// `await music.play(song)` in an async program.
import { music } from "trigscript/music";
const lead = music.synth({ release: 0.05 });
const tune = music.song({ bpm: 120 }, music.track(lead, "C5 - E5 . G5 - - ."));
program(async () => {
  await music.play(tune);
});
