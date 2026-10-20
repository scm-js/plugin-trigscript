// ledger: step 5, refused: the action Play WAV
// An instrument to start from: `music.presets.chip()`.
import { music } from "trigscript/music";
const chip = music.presets.chip();
const tune = music.song({ bpm: 120 }, music.track(chip, "C5 E5 G5 E5"));
program(async () => {
  await music.play(tune);
});
