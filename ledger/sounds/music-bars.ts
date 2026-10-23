// ledger: step 5, takes
// How long bars last at a tempo, as a song plays them: `music.bars(120, 1)`, the length of a riser.
import { music } from "trigscript/music";
const rise = music.riser(music.bars(240, 1), { volume: 0.3 });
program(() => {
  playWav(rise, 0);
});
