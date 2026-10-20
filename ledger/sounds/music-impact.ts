// ledger: step 5, refused: the action Play WAV
// A boom to land on, made when the map is built: `music.impact()`.
import { music } from "trigscript/music";
const boom = music.impact({ seconds: 0.5 });
program(() => {
  playWav(boom, 0);
});
