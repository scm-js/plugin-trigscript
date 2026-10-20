// ledger: step 5, refused: the action Play WAV
// Noise rising through an opening filter, made when the map is built: `music.riser(seconds)`.
import { music } from "trigscript/music";
const rise = music.riser(1, { volume: 0.3 });
program(() => {
  playWav(rise, 0);
});
