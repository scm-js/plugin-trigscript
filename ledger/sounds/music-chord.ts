// ledger: step 5, refused: the action Play WAV
// A chord by its name, its notes sounding together: `music.chord("Am")`.
import { music } from "trigscript/music";
const keys = music.synth({ volume: 0.1, release: 0.05 });
const tune = music.song({ bpm: 120 }, music.track(keys, `${music.chord("Am")} - - .`));
program(async () => {
  await music.play(tune);
});
